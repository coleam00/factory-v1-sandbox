import { describe, expect, test } from "bun:test";
import type { Book } from "../src/db";
import { startServer } from "../src/server";
import { page } from "../src/views";

const appSource = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
const origin = "http://shelf.test";

class TestHtmlFormElement {
  constructor(
    readonly method: string,
    readonly action: string,
    readonly classes: Set<string>,
    readonly controls: Array<{ label: string; name: string; value: string }>,
  ) {}

  readonly classList = {
    contains: (name: string) => this.classes.has(name),
  };

  setValue(label: string, value: string) {
    const control = this.controls.find((candidate) => candidate.label === label);
    if (!control) throw new Error(`Rendered form has no ${label} control`);
    control.value = value;
  }
}

class TestFormData extends FormData {
  readonly fields: Record<string, string>;

  constructor(form: TestHtmlFormElement) {
    super();
    this.fields = Object.fromEntries(form.controls.map(({ name, value }) => [name, value]));
    for (const [name, value] of Object.entries(this.fields)) this.append(name, value);
  }
}

class TestSubmitEvent {
  defaultPrevented = false;

  constructor(readonly target: TestHtmlFormElement) {}

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class TestDocument {
  handler?: (event: TestSubmitEvent) => Promise<void>;
  readonly replacements: string[] = [];
  currentMain: TestMain;

  constructor(html: string) {
    this.currentMain = new TestMain(this, mainMarkup(html));
  }

  addEventListener(type: string, handler: (event: TestSubmitEvent) => Promise<void>) {
    if (type === "submit") this.handler = handler;
  }

  querySelector(selector: string) {
    if (selector === "main") return this.currentMain;
    return null;
  }

  page(html: string) {
    return {
      querySelector: (selector: string) => {
        if (selector !== "main") return null;
        const markup = maybeMainMarkup(html);
        return markup ? new TestMain(this, markup) : null;
      },
    };
  }
}

class TestMain {
  constructor(
    private readonly document: TestDocument,
    readonly markup: string,
  ) {}

  replaceWith(next: TestMain) {
    this.document.replacements.push(next.markup);
    this.document.currentMain = next;
  }
}

function maybeMainMarkup(html: string) {
  const start = html.indexOf("<main>");
  const end = html.indexOf("</main>", start);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end + "</main>".length);
}

function mainMarkup(html: string) {
  const markup = maybeMainMarkup(html);
  if (!markup) throw new Error("Rendered page has no main element");
  return markup;
}

function emptyStateContents(html: string) {
  return html.match(/<div class="empty">([\s\S]*?)<\/div>/)?.[1];
}

function attribute(openingTag: string, name: string) {
  return openingTag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function renderedForm(html: string, action: string) {
  const actionIndex = html.indexOf(`action="${action}"`);
  if (actionIndex < 0) throw new Error(`Rendered page has no form for ${action}`);
  const start = html.lastIndexOf("<form", actionIndex);
  const openingEnd = html.indexOf(">", actionIndex);
  const end = html.indexOf("</form>", openingEnd);
  const openingTag = html.slice(start, openingEnd + 1);
  const formMarkup = html.slice(start, end + "</form>".length);
  const classes = new Set((attribute(openingTag, "class") ?? "").split(/\s+/).filter(Boolean));
  const controls = [...formMarkup.matchAll(/<input\b[^>]*>/g)].flatMap((match) => {
    const name = attribute(match[0], "name");
    if (!name) return [];
    const labelStart = formMarkup.lastIndexOf("<label>", match.index);
    const label = labelStart < 0 ? "" : formMarkup.slice(labelStart + "<label>".length, match.index);
    return [{ label, name, value: attribute(match[0], "value") ?? "" }];
  });

  return new TestHtmlFormElement(
    attribute(openingTag, "method") ?? "get",
    new URL(action, origin).href,
    classes,
    controls,
  );
}

function renderedMutationForm(html: string, operation: "toggle" | "delete") {
  const action = html.match(new RegExp(`action="([^"]+/${operation})"`))?.[1];
  if (!action) throw new Error(`Rendered page has no ${operation} form`);
  return renderedForm(html, action);
}

function book(id: number, title: string, read = false): Book {
  return { id, title, author: "Test Author", read, createdAt: "2026-01-01 00:00:00" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clientHarness(
  initialPage: string,
  fetch: (url: string, options: { method: string; body: TestFormData }) => Promise<Response>,
  confirm = () => true,
) {
  const document = new TestDocument(initialPage);
  let reloads = 0;
  class TestDomParser {
    parseFromString(html: string) {
      return document.page(html);
    }
  }

  new Function(
    "document",
    "HTMLFormElement",
    "confirm",
    "fetch",
    "FormData",
    "DOMParser",
    "window",
    appSource,
  )(
    document,
    TestHtmlFormElement,
    confirm,
    fetch,
    TestFormData,
    TestDomParser,
    { location: { reload: () => reloads++ } },
  );

  if (!document.handler) throw new Error("Client script did not register a submit handler");
  return { document, submit: document.handler, reloads: () => reloads };
}

function serverBackedClient(
  initialPage: string,
  app: ReturnType<typeof startServer>,
  requests: string[],
) {
  return clientHarness(initialPage, async (url, options) => {
    requests.push(url);
    return fetch(new URL(new URL(url).pathname, app.server.url), {
      method: options.method,
      body: options.body,
    });
  });
}

async function addServerBook(app: ReturnType<typeof startServer>) {
  const response = await fetch(new URL("/books", app.server.url), {
    method: "POST",
    body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }),
  });
  return response.text();
}

describe("browser shelf mutations", () => {
  test("adds the first book in place without navigating", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    try {
      const initialPage = page([]);
      const requests: string[] = [];
      const client = serverBackedClient(initialPage, app, requests);
      const form = renderedForm(initialPage, "/books");
      form.setValue("Title", "Kindred");
      form.setValue("Author", "Octavia E. Butler");
      const event = new TestSubmitEvent(form);

      await client.submit(event);

      expect(event.defaultPrevented).toBe(true);
      expect(client.reloads()).toBe(0);
      expect(requests).toEqual([`${origin}/books`]);
      expect(client.document.currentMain.markup).toContain("Kindred");
      expect(client.document.currentMain.markup).toContain("<b>0</b> of 1 read");
      expect(client.document.currentMain.markup).not.toContain("Your shelf is empty");
    } finally {
      app.close();
    }
  });

  test("serializes overlapping add, toggle, and delete mutations", async () => {
    const existing = book(1, "Kindred");
    const added = book(2, "Submitted title");
    const initialPage = page([existing]);
    const toggleResponse = deferred<Response>();
    const addResponse = deferred<Response>();
    const deleteResponse = deferred<Response>();
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const client = clientHarness(initialPage, (url, options) => {
      requests.push({ url, body: options.body.fields });
      if (url.endsWith("/toggle")) return toggleResponse.promise;
      if (url.endsWith("/delete")) return deleteResponse.promise;
      return addResponse.promise;
    });
    const toggle = new TestSubmitEvent(renderedForm(initialPage, "/books/1/toggle"));
    const addForm = renderedForm(initialPage, "/books");
    addForm.setValue("Title", "Submitted title");
    addForm.setValue("Author", "Submitted author");
    const add = new TestSubmitEvent(addForm);
    const remove = new TestSubmitEvent(renderedForm(initialPage, "/books/1/delete"));

    const toggleSubmission = client.submit(toggle);
    const addSubmission = client.submit(add);
    const deleteSubmission = client.submit(remove);
    addForm.setValue("Title", "Edited after submit");
    addForm.setValue("Author", "Edited author");
    deleteResponse.resolve(new Response(page([added])));
    addResponse.resolve(new Response(page([added, { ...existing, read: true }])));
    toggleResponse.resolve(new Response(page([{ ...existing, read: true }])));
    await Promise.all([toggleSubmission, addSubmission, deleteSubmission]);

    expect(requests).toEqual([
      { url: `${origin}/books/1/toggle`, body: {} },
      {
        url: `${origin}/books`,
        body: { title: "Submitted title", author: "Submitted author" },
      },
      { url: `${origin}/books/1/delete`, body: {} },
    ]);
    expect(client.document.currentMain.markup).toContain("Submitted title");
    expect(client.document.currentMain.markup).toContain("<b>0</b> of 1 read");
    expect(client.document.currentMain.markup).not.toContain("Kindred");
    expect(client.reloads()).toBe(0);
  });

  test("confirms a rendered delete before submitting it", async () => {
    const initialPage = page([book(1, "Kindred")]);
    let requests = 0;
    let confirmations = 0;
    const client = clientHarness(
      initialPage,
      async () => {
        requests++;
        return new Response(page([]));
      },
      () => {
        confirmations++;
        return false;
      },
    );
    const form = renderedForm(initialPage, "/books/1/delete");
    const event = new TestSubmitEvent(form);

    await client.submit(event);

    expect(event.defaultPrevented).toBe(true);
    expect(confirmations).toBe(1);
    expect(requests).toBe(0);
    expect(client.document.replacements).toEqual([]);
    expect(client.reloads()).toBe(0);
  });

  test("deletes the final book in place", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    try {
      const initialPage = await addServerBook(app);
      const requests: string[] = [];
      const client = serverBackedClient(initialPage, app, requests);
      const event = new TestSubmitEvent(renderedMutationForm(initialPage, "delete"));

      await client.submit(event);

      expect(event.defaultPrevented).toBe(true);
      expect(requests).toEqual([`${origin}/books/1/delete`]);
      expect(client.reloads()).toBe(0);
      expect(emptyStateContents(client.document.currentMain.markup)).toBe(
        "<p>Your shelf is empty. Add your first book above.</p>",
      );
      expect(client.document.currentMain.markup).not.toContain('class="count"');
    } finally {
      app.close();
    }
  });

  test("toggles a rendered book in place", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    try {
      const initialPage = await addServerBook(app);
      const requests: string[] = [];
      const client = serverBackedClient(initialPage, app, requests);
      const event = new TestSubmitEvent(renderedMutationForm(initialPage, "toggle"));

      await client.submit(event);

      expect(event.defaultPrevented).toBe(true);
      expect(requests).toEqual([`${origin}/books/1/toggle`]);
      expect(client.reloads()).toBe(0);
      expect(client.document.currentMain.markup).toContain('class="book is-read"');
      expect(client.document.currentMain.markup).toContain('<b>1</b> of 1 read');
      expect(client.document.currentMain.markup).toContain('aria-label="Mark unread"');
    } finally {
      app.close();
    }
  });

  test("reloads when a mutation cannot be confirmed", async () => {
    const initialPage = page([]);
    const client = clientHarness(initialPage, async () => {
      throw new Error("network unavailable");
    });
    const form = renderedForm(initialPage, "/books");
    form.setValue("Title", "Kindred");
    form.setValue("Author", "Octavia E. Butler");
    await client.submit(new TestSubmitEvent(form));

    expect(client.document.replacements).toEqual([]);
    expect(client.reloads()).toBe(1);
  });

  test("reloads when a mutation response has no page content", async () => {
    const initialPage = page([book(1, "Kindred")]);
    const client = clientHarness(initialPage, async () => new Response("Not a shelf page"));

    await client.submit(new TestSubmitEvent(renderedForm(initialPage, "/books/1/toggle")));

    expect(client.document.replacements).toEqual([]);
    expect(client.reloads()).toBe(1);
  });
});
