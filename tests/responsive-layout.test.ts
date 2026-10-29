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
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("Chrome or Chromium is required; set CHROME_PATH to its executable");
  return executable;
}

async function devtoolsPort(profile: string) {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) return Number(readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]);
    await Bun.sleep(50);
  }
  throw new Error("Chrome did not expose a DevTools port");
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

test(
  "keeps complete long book text and controls usable at 320px",
  async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    const profile = mkdtempSync(join(tmpdir(), "shelf-browser-"));
    const browser = Bun.spawn([
      chromeExecutable(),
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ]);
    let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;

    try {
      const title = "T".repeat(200);
      const author = "A".repeat(200);
      const created = await fetch(new URL("/books", app.server.url), {
        method: "POST",
        body: new URLSearchParams({ title, author }),
        redirect: "manual",
      });
      expect(created.status).toBe(303);

      const port = await devtoolsPort(profile);
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

      const focusOrder: string[] = [];
      for (let step = 0; step < 5; step += 1) {
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
            const active = document.activeElement;
            if (active.matches('input[name="title"]')) return 'title';
            if (active.matches('input[name="author"]')) return 'author';
            if (active.matches('.add button')) return 'add';
            if (active.matches('.check')) return 'check';
            if (active.matches('.delete')) return 'delete';
            return 'other';
          })()`,
        })) as { result: { value: string } };
        focusOrder.push(focused.result.value);
      }
      expect(focusOrder).toEqual(["title", "author", "add", "check", "delete"]);
    } finally {
      cdp?.close();
      browser.kill();
      await browser.exited;
      app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
  15_000,
);
