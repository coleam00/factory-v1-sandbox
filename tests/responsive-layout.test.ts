import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
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
  profile: string,
  browser: ReturnType<typeof Bun.spawn>,
  diagnostics: ReturnType<typeof captureBrowserOutput>,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const port = Number(
        readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/, 1)[0],
      );
      if (Number.isInteger(port) && port > 0) return port;
    } catch {}
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
  const events = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: Error) => void }>
  >();
  let nextId = 1;
  let terminalError: Error | undefined;

  const terminate = () => {
    if (terminalError) return;
    terminalError = new Error("Chrome DevTools connection closed");
    for (const request of pending.values()) request.reject(terminalError);
    pending.clear();
    for (const listeners of events.values()) {
      for (const listener of listeners) listener.reject(terminalError);
    }
    events.clear();
  };

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
    if (message.method) {
      const listeners = events.get(message.method);
      events.delete(message.method);
      listeners?.forEach(({ resolve }) => resolve());
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools")), {
      once: true,
    });
  });
  socket.addEventListener("close", terminate, { once: true });
  socket.addEventListener("error", terminate, { once: true });

  return {
    send(method: string, params: Record<string, unknown> = {}) {
      if (terminalError) return Promise.reject(terminalError);
      const id = nextId++;
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    event(method: string) {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise<void>((resolve, reject) => {
        const listeners = events.get(method) ?? [];
        listeners.push({ resolve, reject });
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
  { name: "skip", selector: ".skip-link" },
  { name: "title", selector: 'input[name="title"]' },
  { name: "author", selector: 'input[name="author"]' },
  { name: "add", selector: ".add button" },
  { name: "backup", selector: ".backup-link" },
  { name: "filter", selector: 'select[name="filter"]' },
  { name: "order", selector: 'select[name="order"]' },
  { name: "apply", selector: ".view-controls button" },
  { name: "check", selector: ".check" },
  { name: "delete", selector: ".delete" },
] as const;

type FocusTargetName = (typeof focusTargets)[number]["name"];

function isFocusTargetName(value: unknown): value is FocusTargetName {
  return typeof value === "string" && focusTargets.some(({ name }) => name === value);
}

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

function waitForDom(cdp: CdpClient, condition: string) {
  return cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      let observer;
      const settle = () => {
        if (!(${condition})) return;
        observer?.disconnect();
        resolve(true);
      };
      observer = new MutationObserver(settle);
      observer.observe(document, { attributes: true, childList: true, subtree: true });
      settle();
    })`,
  });
}

const chromePath = chromeExecutable();
const responsiveLayoutTest = chromePath ? test : test.skip;

responsiveLayoutTest(
  "keeps book text and controls usable across narrow and wide layouts",
  async () => {
    if (!chromePath) return;

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
          chromePath,
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
      const ordinaryTitle = "The Left Hand of Darkness";
      const ordinaryAuthor = "Ursula Kroeber Le Guin";
      const port = await devtoolsPort(profile, browser, browserOutput);
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
      expect(renderedForm.result.value).toEqual({ titleMaxLength: -1, authorMaxLength: -1 });

      await click(cdp, 'input[name="title"]');
      await cdp.send("Input.insertText", { text: title });
      await click(cdp, 'input[name="author"]');
      await cdp.send("Input.insertText", { text: author });
      const added = waitForDom(
        cdp,
        `document.querySelector('.book strong')?.textContent === ${JSON.stringify(title)}`,
      );
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
            titleVisible: title.scrollHeight <= title.clientHeight,
            authorVisible: author.scrollHeight <= author.clientHeight,
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
        titleVisible: boolean;
        authorVisible: boolean;
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
      expect(layout.titleVisible).toBe(true);
      expect(layout.authorVisible).toBe(true);
      expect(layout.addControls).toHaveLength(3);
      expect(layout.rowControls).toHaveLength(2);
      for (const control of [...layout.addControls, ...layout.rowControls]) {
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(layout.viewportWidth);
      }
      for (const control of layout.rowControls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);

      const expectedFocusOrder = focusTargets
        .map(({ name }) => name)
        .filter((name) => name !== "skip");
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
            if (!document.hasFocus()) return null;
            const active = document.activeElement;
            const target = ${JSON.stringify(focusTargets)}.find(({ selector }) =>
              active?.matches(selector)
            );
            if (target) return target.name;

            const attributes = ["name", "type", "href", "aria-label"]
              .filter((name) => active?.hasAttribute(name))
              .map((name) => "[" + name + "=" + JSON.stringify(active?.getAttribute(name)) + "]")
              .join("");
            return active
              ? [
                  active.tagName.toLowerCase(),
                  active.id && "#" + active.id,
                  active.className && "." + String(active.className).trim().replaceAll(" ", "."),
                  attributes,
                ].filter(Boolean).join("")
              : "null";
          })()`,
        })) as { result: { value: unknown } };
        const focus = focused.result.value;
        if (focus === null) continue;
        if (!isFocusTargetName(focus)) {
          throw new Error(`Unexpected in-document focus target: ${String(focus)}`);
        }
        focusOrder.push(focus);
        if (focus === "delete") break;
      }
      expect(focusOrder).toEqual(expectedFocusOrder);

      const rowControlVisibility = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const fullyInsideClippingAncestors = (element, rect) => {
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              if (style.overflowX === "visible" && style.overflowY === "visible") continue;
              const ancestorRect = ancestor.getBoundingClientRect();
              const clipLeft = ancestorRect.left + ancestor.clientLeft;
              const clipTop = ancestorRect.top + ancestor.clientTop;
              if (style.overflowX !== "visible" &&
                  (rect.left < clipLeft || rect.right > clipLeft + ancestor.clientWidth)) return false;
              if (style.overflowY !== "visible" &&
                  (rect.top < clipTop || rect.bottom > clipTop + ancestor.clientHeight)) return false;
            }
            return true;
          };
          const ownsInsetPoints = (element, rect) => [0.2, 0.5, 0.8].every((x) =>
            [0.2, 0.5, 0.8].every((y) => element.contains(document.elementFromPoint(
              rect.left + rect.width * x,
              rect.top + rect.height * y,
            )))
          );
          return [...document.querySelectorAll('.book button')].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              visible:
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                rect.width > 0 && rect.height > 0 &&
                fullyInsideClippingAncestors(element, rect) && ownsInsetPoints(element, rect),
            };
          });
        })()`,
      })) as {
        result: { value: Array<{ top: number; bottom: number; visible: boolean }> };
      };
      expect(rowControlVisibility.result.value).toHaveLength(2);
      for (const control of rowControlVisibility.result.value) {
        expect(control.top).toBeGreaterThanOrEqual(0);
        expect(control.bottom).toBeLessThanOrEqual(900);
        expect(control.bottom).toBeGreaterThan(control.top);
        expect(control.visible).toBe(true);
      }

      const toggled = waitForDom(
        cdp,
        "document.querySelector('.book')?.classList.contains('is-read')",
      );
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
      expect(readState.result.value).toEqual({
        count: "1 of 1 read",
        action: `Mark ${title} as unread (book 1)`,
        isRead: true,
      });

      const dialog = cdp.event("Page.javascriptDialogOpening");
      const deleted = waitForDom(cdp, "!document.querySelector('.book')");
      const deleteClick = click(cdp, ".delete");
      await dialog;
      await cdp.send("Page.handleJavaScriptDialog", { accept: true });
      await deleteClick;
      await deleted;
      const emptyState = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          count: document.querySelector('.count')?.textContent.trim() ?? null,
          books: document.querySelectorAll('.book').length,
          message: document.querySelector('.empty p').textContent,
        }))()`,
      })) as { result: { value: { count: string | null; books: number; message: string } } };
      expect(emptyState.result.value).toEqual({
        count: null,
        books: 0,
        message: "Your shelf is empty. Add your first book above.",
      });

      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 760,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await click(cdp, 'input[name="title"]');
      await cdp.send("Input.insertText", { text: ordinaryTitle });
      await click(cdp, 'input[name="author"]');
      await cdp.send("Input.insertText", { text: ordinaryAuthor });
      const ordinaryAdded = waitForDom(
        cdp,
        `document.querySelector('.book strong')?.textContent === ${JSON.stringify(ordinaryTitle)}`,
      );
      await click(cdp, ".add button");
      await ordinaryAdded;

      const ordinaryText = (await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const title = document.querySelector('.book strong');
          const author = document.querySelector('.book span');
          const textLines = (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          };
          return {
            viewportWidth: window.innerWidth,
            title: title.textContent,
            author: author.textContent,
            titleLines: textLines(title),
            authorLines: textLines(author),
          };
        })()`,
      })) as {
        result: {
          value: {
            viewportWidth: number;
            title: string;
            author: string;
            titleLines: number;
            authorLines: number;
          };
        };
      };
      expect(ordinaryText.result.value).toEqual({
        viewportWidth: 760,
        title: ordinaryTitle,
        author: ordinaryAuthor,
        titleLines: 1,
        authorLines: 1,
      });

      const pendingCommand = cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        expression: "new Promise(() => {})",
      });
      const pendingEvent = cdp.event("Page.loadEventFired");
      const terminalWaiters = Promise.allSettled([pendingCommand, pendingEvent]);
      browser.kill();
      const terminalResults = await terminalWaiters;
      expect(terminalResults.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
      expect(
        terminalResults.map((result) =>
          result.status === "rejected" ? String(result.reason) : "resolved",
        ),
      ).toEqual([
        "Error: Chrome DevTools connection closed",
        "Error: Chrome DevTools connection closed",
      ]);
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
