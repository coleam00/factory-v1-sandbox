import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { expect, test } from "bun:test";
import { startServer } from "../src/server";

type Decoder<T> = (value: unknown, path?: string) => T;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

const stringValue: Decoder<string> = (value, path = "value") => {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
};

const finiteNumber: Decoder<number> = (value, path = "value") => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
};

const booleanValue: Decoder<boolean> = (value, path = "value") => {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
};

function nullable<T>(decode: Decoder<T>): Decoder<T | null> {
  return (value, path = "value") => (value === null ? null : decode(value, path));
}

function array<T>(decode: Decoder<T>): Decoder<T[]> {
  return (value, path = "value") => {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return value.map((item, index) => decode(item, `${path}[${index}]`));
  };
}

function object<T>(fields: { [Key in keyof T]: Decoder<T[Key]> }): Decoder<T> {
  return (value, path = "value") => {
    const source = record(value, path);
    return Object.fromEntries(
      Object.entries<Decoder<unknown>>(fields).map(([key, decode]) => [
        key,
        decode(source[key], `${path}.${key}`),
      ]),
    ) as T;
  };
}

type CdpMessage =
  | { kind: "event"; method: string }
  | { kind: "response"; id: number; result: unknown }
  | { kind: "error"; id: number; message: string };

function decodeCdpMessage(value: unknown): CdpMessage {
  const message = record(value, "CDP message");
  if (Object.hasOwn(message, "id")) {
    const id = finiteNumber(message.id, "CDP message.id");
    if (message.error !== undefined) {
      const error = record(message.error, "CDP error");
      return {
        kind: "error",
        id,
        message: stringValue(error.message, "CDP error.message"),
      };
    }
    if (Object.hasOwn(message, "result")) {
      return {
        kind: "response",
        id,
        result: message.result,
      };
    }
    throw new Error("CDP response must contain result or error");
  }
  if (typeof message.method === "string") {
    return { kind: "event", method: message.method };
  }
  throw new Error("CDP message must be an event or response");
}

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
  const events = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: Error) => void }>
  >();
  let nextId = 1;
  let connectionError: Error | undefined;

  const failConnection = (error: Error) => {
    if (connectionError) return;
    connectionError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const listeners of events.values()) {
      for (const listener of listeners) listener.reject(error);
    }
    events.clear();
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };

  socket.addEventListener("message", (event) => {
    if (connectionError) return;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      const message = decodeCdpMessage(parsed);
      if (message.kind === "event") {
        const listeners = events.get(message.method);
        events.delete(message.method);
        listeners?.forEach(({ resolve }) => resolve());
        return;
      }

      const request = pending.get(message.id);
      if (!request) {
        failConnection(new Error(`CDP response ${message.id} did not match a pending request`));
        return;
      }
      pending.delete(message.id);
      if (message.kind === "error") request.reject(new Error(message.message));
      else request.resolve(message.result);
    } catch (error) {
      failConnection(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.addEventListener("error", () => {
    failConnection(new Error("Chrome DevTools connection failed"));
  });
  socket.addEventListener("close", () => {
    failConnection(new Error("Chrome DevTools connection closed"));
  });

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onFailure);
      socket.removeEventListener("close", onFailure);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onFailure = () => {
      cleanup();
      reject(connectionError ?? new Error("Could not connect to Chrome DevTools"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onFailure);
    socket.addEventListener("close", onFailure);
  });

  return {
    send(method: string, params: Record<string, unknown> = {}) {
      if (connectionError) return Promise.reject(connectionError);
      const id = nextId++;
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        failConnection(error instanceof Error ? error : new Error(String(error)));
      }
      return response;
    },
    event(method: string) {
      if (connectionError) return Promise.reject(connectionError);
      return new Promise<void>((resolve, reject) => {
        const listeners = events.get(method) ?? [];
        listeners.push({ resolve, reject });
        events.set(method, listeners);
      });
    },
    close() {
      failConnection(new Error("Chrome DevTools connection closed"));
    },
  };
}

type CdpClient = Awaited<ReturnType<typeof connectCdp>>;

function decodeEvaluation<T>(value: unknown, decode: Decoder<T>): T {
  const evaluation = record(value, "Runtime.evaluate result");
  if (Object.hasOwn(evaluation, "exceptionDetails")) {
    throw new Error(
      `Runtime.evaluate failed: ${JSON.stringify(evaluation.exceptionDetails) ?? "unknown exception"}`,
    );
  }

  const remoteObject = record(evaluation.result, "Runtime.evaluate result.result");
  if (!Object.hasOwn(remoteObject, "value")) {
    throw new Error("Runtime.evaluate result.result must contain a value");
  }
  return decode(remoteObject.value, "Runtime.evaluate value");
}

async function evaluate<T>(cdp: CdpClient, expression: string, decode: Decoder<T>): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", { returnByValue: true, expression });
  return decodeEvaluation(result, decode);
}

const focusTargets = [
  { name: "skip", selector: ".skip-link" },
  { name: "title", selector: 'input[name="title"]' },
  { name: "author", selector: 'input[name="author"]' },
  { name: "add", selector: ".add button" },
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

const focusTarget: Decoder<FocusTargetName | null> = (value) => {
  if (value === null) return null;
  if (!isFocusTargetName(value)) {
    throw new Error(`Unexpected in-document focus target: ${String(value)}`);
  }
  return value;
};

type Bounds = { left: number; right: number };

const bounds = object<Bounds>({ left: finiteNumber, right: finiteNumber });
const point = nullable(
  object<{ x: number; y: number }>({ x: finiteNumber, y: finiteNumber }),
);
const target = object<{ webSocketDebuggerUrl: string }>({ webSocketDebuggerUrl: stringValue });
const renderedForm = object<{ titleMaxLength: number; authorMaxLength: number }>({
  titleMaxLength: finiteNumber,
  authorMaxLength: finiteNumber,
});
const layout = object<{
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
  addControls: Bounds[];
  rowControls: Array<Bounds & { tabIndex: number }>;
}>({
  viewportWidth: finiteNumber,
  documentWidth: finiteNumber,
  bodyWidth: finiteNumber,
  title: stringValue,
  author: stringValue,
  titleLines: finiteNumber,
  authorLines: finiteNumber,
  titleFits: booleanValue,
  authorFits: booleanValue,
  titleVisible: booleanValue,
  authorVisible: booleanValue,
  addControls: array(bounds),
  rowControls: array(
    object<Bounds & { tabIndex: number }>({
      left: finiteNumber,
      right: finiteNumber,
      tabIndex: finiteNumber,
    }),
  ),
});
const readState = object<{ count: string; action: string; isRead: boolean }>({
  count: stringValue,
  action: stringValue,
  isRead: booleanValue,
});
const emptyState = object<{ count: string; books: number; message: string }>({
  count: stringValue,
  books: finiteNumber,
  message: stringValue,
});
const ordinaryText = object<{
  viewportWidth: number;
  title: string;
  author: string;
  titleLines: number;
  authorLines: number;
}>({
  viewportWidth: finiteNumber,
  title: stringValue,
  author: stringValue,
  titleLines: finiteNumber,
  authorLines: finiteNumber,
});

test("rejects malformed Chrome boundary payloads", () => {
  const rejectedPayloads: Array<[string, () => unknown]> = [
    ["CDP response", () => decodeCdpMessage({ id: 1 })],
    ["CDP error", () => decodeCdpMessage({ id: 1, error: { message: 500 } })],
    ["CDP string identifier", () => decodeCdpMessage({ id: "1", method: "Page.loadEventFired" })],
    ["CDP boolean identifier", () => decodeCdpMessage({ id: true, method: "Page.loadEventFired" })],
    ["CDP null identifier", () => decodeCdpMessage({ id: null, method: "Page.loadEventFired" })],
    ["CDP object identifier", () => decodeCdpMessage({ id: {}, method: "Page.loadEventFired" })],
    ["CDP array identifier", () => decodeCdpMessage({ id: [], method: "Page.loadEventFired" })],
    ["CDP NaN identifier", () => decodeCdpMessage({ id: NaN, method: "Page.loadEventFired" })],
    ["CDP infinite identifier", () => decodeCdpMessage({ id: Infinity, method: "Page.loadEventFired" })],
    [
      "evaluation exception",
      () => decodeEvaluation({ result: { value: null }, exceptionDetails: {} }, nullable(stringValue)),
    ],
    ["evaluation result", () => decodeEvaluation({ result: {} }, stringValue)],
    ["target discovery", () => target({ webSocketDebuggerUrl: 42 })],
    ["click coordinates", () => point({ x: "left", y: 10 })],
    ["form limits", () => renderedForm({ titleMaxLength: "200", authorMaxLength: 200 })],
    ["narrow layout", () => layout({ viewportWidth: 320 })],
    ["focus", () => focusTarget("unexpected")],
    ["toggle state", () => readState({ count: 1 })],
    ["empty state", () => emptyState({ books: "none" })],
    ["wide text", () => ordinaryText({ viewportWidth: "760" })],
  ];

  for (const [name, decode] of rejectedPayloads) {
    try {
      decode();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      continue;
    }
    throw new Error(`${name} accepted a malformed payload`);
  }
});

type CdpTestPeer = Pick<ServerWebSocket, "send" | "terminate">;

function cdpTestServer() {
  let acceptPeer: (peer: CdpTestPeer) => void;
  const peer = new Promise<CdpTestPeer>((resolve) => {
    acceptPeer = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        acceptPeer(socket);
      },
      message() {},
    },
  });
  const url = new URL(server.url);
  url.protocol = "ws:";
  return { peer, url: url.href, stop: () => server.stop(true) };
}

async function rejectionOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Promise rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error("Expected promise to reject");
}

test("rejects current and future CDP waiters after terminal failures", async () => {
  const closedServer = cdpTestServer();
  const malformedServer = cdpTestServer();
  const unknownResponseServer = cdpTestServer();

  try {
    const closedClient = await connectCdp(closedServer.url);
    const closedPeer = await closedServer.peer;
    const command = closedClient.send("Page.enable");
    const event = closedClient.event("Page.loadEventFired");
    const secondEvent = closedClient.event("Page.loadEventFired");
    const commandRejected = rejectionOf(command);
    const eventRejected = rejectionOf(event);
    const secondEventRejected = rejectionOf(secondEvent);
    closedPeer.terminate();
    const [commandError, eventError, secondEventError] = await Promise.all([
      commandRejected,
      eventRejected,
      secondEventRejected,
    ]);
    expect(commandError.message).toBe("Chrome DevTools connection closed");
    expect(eventError.message).toBe("Chrome DevTools connection closed");
    expect(secondEventError).toBe(eventError);
    expect((await rejectionOf(closedClient.send("Runtime.enable"))).message).toBe(
      "Chrome DevTools connection closed",
    );
    expect((await rejectionOf(closedClient.event("Page.loadEventFired"))).message).toBe(
      "Chrome DevTools connection closed",
    );

    const malformedClient = await connectCdp(malformedServer.url);
    const malformedPeer = await malformedServer.peer;
    const malformedEvent = malformedClient.event("Page.loadEventFired");
    const malformedEventRejected = rejectionOf(malformedEvent);
    malformedPeer.send('{"id":"not-a-number","method":"Page.loadEventFired"}');
    expect((await malformedEventRejected).message).toBe(
      "CDP message.id must be a finite number",
    );

    const unknownResponseClient = await connectCdp(unknownResponseServer.url);
    const unknownResponsePeer = await unknownResponseServer.peer;
    const unknownResponseEvent = unknownResponseClient.event("Page.loadEventFired");
    const unknownResponseEventRejected = rejectionOf(unknownResponseEvent);
    unknownResponsePeer.send('{"id":999,"result":{}}');
    expect((await unknownResponseEventRejected).message).toBe(
      "CDP response 999 did not match a pending request",
    );
  } finally {
    await Promise.all([
      closedServer.stop(),
      malformedServer.stop(),
      unknownResponseServer.stop(),
    ]);
  }
});

async function click(cdp: CdpClient, selector: string) {
  const clickPoint = await evaluate(
    cdp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    point,
  );
  if (!clickPoint) throw new Error(`Could not find ${selector}`);

  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...clickPoint });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...clickPoint,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...clickPoint,
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
      const port = await devtoolsPort(browser, browserOutput);
      const targetPayload: unknown = await (
        await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: "PUT" })
      ).json();
      const browserTarget = target(targetPayload, "Chrome target");
      cdp = await connectCdp(browserTarget.webSocketDebuggerUrl);
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

      const formLimits = await evaluate(
        cdp,
        `(() => ({
          titleMaxLength: document.querySelector('input[name="title"]').maxLength,
          authorMaxLength: document.querySelector('input[name="author"]').maxLength,
        }))()`,
        renderedForm,
      );
      expect(formLimits).toEqual({ titleMaxLength: 200, authorMaxLength: 200 });

      await click(cdp, 'input[name="title"]');
      await cdp.send("Input.insertText", { text: title });
      await click(cdp, 'input[name="author"]');
      await cdp.send("Input.insertText", { text: author });
      const added = cdp.event("Page.loadEventFired");
      await click(cdp, ".add button");
      await added;

      const narrowLayout = await evaluate(
        cdp,
        `(() => {
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
        layout,
      );

      expect(narrowLayout.viewportWidth).toBe(320);
      expect(narrowLayout.documentWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      expect(narrowLayout.bodyWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      expect(narrowLayout.title).toBe(title);
      expect(narrowLayout.author).toBe(author);
      expect(narrowLayout.titleLines).toBeGreaterThan(1);
      expect(narrowLayout.authorLines).toBeGreaterThan(1);
      expect(narrowLayout.titleFits).toBe(true);
      expect(narrowLayout.authorFits).toBe(true);
      expect(narrowLayout.titleVisible).toBe(true);
      expect(narrowLayout.authorVisible).toBe(true);
      expect(narrowLayout.addControls).toHaveLength(3);
      expect(narrowLayout.rowControls).toHaveLength(2);
      for (const control of [...narrowLayout.addControls, ...narrowLayout.rowControls]) {
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      }
      for (const control of narrowLayout.rowControls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);

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
        const focus = await evaluate(
          cdp,
          `(() => {
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
          focusTarget,
        );
        if (focus === null) continue;
        focusOrder.push(focus);
        if (focus === "delete") break;
      }
      expect(focusOrder).toEqual(expectedFocusOrder);

      const toggled = cdp.event("Page.loadEventFired");
      await click(cdp, ".check");
      await toggled;
      const currentReadState = await evaluate(
        cdp,
        `(() => ({
          count: document.querySelector('.count').textContent.trim(),
          action: document.querySelector('.check').getAttribute('aria-label'),
          isRead: document.querySelector('.book').classList.contains('is-read'),
        }))()`,
        readState,
      );
      expect(currentReadState).toEqual({
        count: "1 of 1 read",
        action: `Mark ${title} as unread (book 1)`,
        isRead: true,
      });

      const dialog = cdp.event("Page.javascriptDialogOpening");
      const deleted = cdp.event("Page.loadEventFired");
      const deleteClick = click(cdp, ".delete");
      await dialog;
      await cdp.send("Page.handleJavaScriptDialog", { accept: true });
      await deleteClick;
      await deleted;
      const currentEmptyState = await evaluate(
        cdp,
        `(() => ({
          count: document.querySelector('.count').textContent.trim(),
          books: document.querySelectorAll('.book').length,
          message: document.querySelector('.empty p').textContent,
        }))()`,
        emptyState,
      );
      expect(currentEmptyState).toEqual({
        count: "0 of 0 read",
        books: 0,
        message: "Your shelf is empty.",
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
      const ordinaryAdded = cdp.event("Page.loadEventFired");
      await click(cdp, ".add button");
      await ordinaryAdded;

      const renderedOrdinaryText = await evaluate(
        cdp,
        `(() => {
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
        ordinaryText,
      );
      expect(renderedOrdinaryText).toEqual({
        viewportWidth: 760,
        title: ordinaryTitle,
        author: ordinaryAuthor,
        titleLines: 1,
        authorLines: 1,
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
