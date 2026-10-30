import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { startServer } from "../src/server";

type CdpMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
};

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32"
      ? join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("Chrome or Chromium is required; set CHROME_PATH to its executable");
  return executable;
}

function captureBrowserOutput(browser: ReturnType<typeof Bun.spawn>) {
  if (!(browser.stderr instanceof ReadableStream)) throw new Error("Chrome stderr is not readable");
  const reader = browser.stderr.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const finished = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
  })();
  return { finished, output: () => output };
}

async function devtoolsPort(
  browser: ReturnType<typeof Bun.spawn>,
  diagnostics: ReturnType<typeof captureBrowserOutput>,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = diagnostics.output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (browser.exitCode !== null) {
      await diagnostics.finished;
      throw new Error(
        `Chrome exited before exposing DevTools (exit code ${browser.exitCode}): ${diagnostics.output()}`,
      );
    }
    await Bun.sleep(50);
  }
  throw new Error(`Chrome did not expose DevTools: ${diagnostics.output()}`);
}

async function connectCdp(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const events = new Map<string, Array<() => void>>();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.method) events.get(message.method)?.splice(0).forEach((resolve) => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools")), {
      once: true,
    });
  });

  return {
    send(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    event(method: string) {
      return new Promise<void>((resolve) => {
        const listeners = events.get(method) ?? [];
        listeners.push(resolve);
        events.set(method, listeners);
      });
    },
    close() {
      socket.close();
    },
  };
}

type CdpClient = Awaited<ReturnType<typeof connectCdp>>;

const focusTargets = [
  { name: "title", selector: 'input[name="title"]' },
  { name: "author", selector: 'input[name="author"]' },
  { name: "add", selector: ".add button" },
  { name: "filter", selector: 'select[name="filter"]' },
  { name: "order", selector: 'select[name="order"]' },
  { name: "apply", selector: ".view-controls button" },
  { name: "check", selector: ".check" },
  { name: "delete", selector: ".delete" },
] as const;

type FocusObservation =
  | { kind: "application"; name: (typeof focusTargets)[number]["name"] }
  | { kind: "outside-document" }
  | { kind: "unexpected"; identity: string };

async function click(cdp: CdpClient, selector: string) {
  const evaluated = (await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  })) as { result: { value: { x: number; y: number } | null } };
  const point = evaluated.result.value;
  if (!point) throw new Error(`Could not find ${selector}`);

  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}

test(
  "keeps complete long book text and controls usable at 320px",
  async () => {
    let app: ReturnType<typeof startServer> | undefined;
    let profile: string | undefined;
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let browserOutput: ReturnType<typeof captureBrowserOutput> | undefined;
    let cdp: CdpClient | undefined;

    try {
      app = startServer({ port: 0, dbPath: ":memory:" });
      profile = mkdtempSync(join(tmpdir(), "shelf-browser-"));
      browser = Bun.spawn(
        [
          chromeExecutable(),
          "--headless=new",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      browserOutput = captureBrowserOutput(browser);

      const title = "T".repeat(200);
      const author = "A".repeat(200);
      const port = await devtoolsPort(browser, browserOutput);
      const target = (await (
        await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: "PUT" })
      ).json()) as { webSocketDebuggerUrl: string };
      cdp = await connectCdp(target.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const loaded = cdp.event("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: app.server.url.href });
      await loaded;

      const renderedForm = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          titleMaxLength: document.querySelector('input[name="title"]').maxLength,
          authorMaxLength: document.querySelector('input[name="author"]').maxLength,
        }))()`,
      })) as { result: { value: { titleMaxLength: number; authorMaxLength: number } } };
      expect(renderedForm.result.value).toEqual({ titleMaxLength: 200, authorMaxLength: 200 });

      await click(cdp, 'input[name="title"]');
      await cdp.send("Input.insertText", { text: title });
      await click(cdp, 'input[name="author"]');
      await cdp.send("Input.insertText", { text: author });
      const added = cdp.event("Page.loadEventFired");
      await click(cdp, ".add button");
      await added;

      const evaluated = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const title = document.querySelector('.book strong');
          const author = document.querySelector('.book span');
          const textLines = (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          };
          const bounds = (element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          };
          return {
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            title: title.textContent,
            author: author.textContent,
            titleLines: textLines(title),
            authorLines: textLines(author),
            titleFits: title.scrollWidth <= title.clientWidth,
            authorFits: author.scrollWidth <= author.clientWidth,
            addControls: [...document.querySelectorAll('.add input, .add button')].map(bounds),
            rowControls: [...document.querySelectorAll('.book button')].map((element) => ({
              ...bounds(element),
              tabIndex: element.tabIndex,
            })),
          };
        })()`,
      })) as { result: { value: Record<string, unknown> } };
      const layout = evaluated.result.value as {
        viewportWidth: number;
        documentWidth: number;
        bodyWidth: number;
        title: string;
        author: string;
        titleLines: number;
        authorLines: number;
        titleFits: boolean;
        authorFits: boolean;
        addControls: Array<{ left: number; right: number }>;
        rowControls: Array<{ left: number; right: number; tabIndex: number }>;
      };

      expect(layout.viewportWidth).toBe(320);
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.title).toBe(title);
      expect(layout.author).toBe(author);
      expect(layout.titleLines).toBeGreaterThan(1);
      expect(layout.authorLines).toBeGreaterThan(1);
      expect(layout.titleFits).toBe(true);
      expect(layout.authorFits).toBe(true);
      expect(layout.addControls).toHaveLength(3);
      expect(layout.rowControls).toHaveLength(2);
      for (const control of [...layout.addControls, ...layout.rowControls]) {
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(layout.viewportWidth);
      }
      for (const control of layout.rowControls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);

      const expectedFocusOrder = focusTargets.map(({ name }) => name);
      const focusOrder: string[] = [];
      for (let step = 0; step < expectedFocusOrder.length + 4; step += 1) {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        const focused = (await cdp.send("Runtime.evaluate", {
          returnByValue: true,
          expression: `(() => {
            if (!document.hasFocus()) return { kind: 'outside-document' };
            const active = document.activeElement;
            const target = ${JSON.stringify(focusTargets)}.find(({ selector }) => active?.matches(selector));
            if (target) return { kind: 'application', name: target.name };
            const attributes = active
              ? ['name', 'type', 'href', 'aria-label']
                  .filter((name) => active.hasAttribute(name))
                  .map((name) => '[' + name + '=' + JSON.stringify(active.getAttribute(name)) + ']')
                  .join('')
              : '';
            const identity = active
              ? [active.tagName.toLowerCase(), active.id && '#' + active.id, active.className && '.' + String(active.className).trim().replaceAll(' ', '.'), attributes]
                  .filter(Boolean)
                  .join('')
              : 'null';
            return { kind: 'unexpected', identity };
          })()`,
        })) as { result: { value: FocusObservation } };
        const observation = focused.result.value;
        if (observation.kind === "outside-document") continue;
        if (observation.kind === "unexpected") {
          throw new Error(`Unexpected in-document focus target: ${observation.identity}`);
        }
        focusOrder.push(observation.name);
        if (observation.name === "delete") break;
      }
      expect(focusOrder).toEqual(expectedFocusOrder);

      const toggled = cdp.event("Page.loadEventFired");
      await click(cdp, ".check");
      await toggled;
      const readState = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          count: document.querySelector('.count').textContent.trim(),
          action: document.querySelector('.check').getAttribute('aria-label'),
          isRead: document.querySelector('.book').classList.contains('is-read'),
        }))()`,
      })) as {
        result: { value: { count: string; action: string; isRead: boolean } };
      };
      expect(readState.result.value).toEqual({ count: "1 of 1 read", action: "Mark unread", isRead: true });

      const dialog = cdp.event("Page.javascriptDialogOpening");
      const deleted = cdp.event("Page.loadEventFired");
      const deleteClick = click(cdp, ".delete");
      await dialog;
      await cdp.send("Page.handleJavaScriptDialog", { accept: true });
      await deleteClick;
      await deleted;
      const emptyState = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          count: document.querySelector('.count').textContent.trim(),
          books: document.querySelectorAll('.book').length,
          message: document.querySelector('.empty p').textContent,
        }))()`,
      })) as { result: { value: { count: string; books: number; message: string } } };
      expect(emptyState.result.value).toEqual({
        count: "0 of 0 read",
        books: 0,
        message: "Your shelf is empty.",
      });
    } finally {
      cdp?.close();
      try {
        if (browser) {
          browser.kill();
          await browser.exited;
          await browserOutput?.finished;
        }
      } finally {
        try {
          app?.close();
        } finally {
          if (profile) rmSync(profile, { recursive: true, force: true });
        }
      }
    }
  },
  20_000,
);
