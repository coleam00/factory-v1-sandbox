import { describe, expect, test } from "bun:test";
import type { Book } from "../src/db";
import { page } from "../src/views";

const appSource = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
const origin = "http://shelf.test";

class TestHtmlFormElement {
  constructor(
    readonly method: string,
    readonly action: string,
    readonly classes: Set<string>,
    readonly fields: Record<string, string>,
  ) {}

  readonly classList = {
    contains: (name: string) => this.classes.has(name),
  };
}

class TestHtmlButtonElement {
  disabled = false;
}

class TestFormData {
  constructor(readonly form: TestHtmlFormElement) {}
}

class TestSubmitEvent {
  defaultPrevented = false;

  constructor(
    readonly target: TestHtmlFormElement,
    readonly submitter: TestHtmlButtonElement,
  ) {}

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
    return selector === "main" ? this.currentMain : null;
  }

  page(html: string) {
    return {
      querySelector: (selector: string) =>
        selector === "main" ? new TestMain(this, mainMarkup(html)) : null,
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

function mainMarkup(html: string) {
  const start = html.indexOf("<main>");
  const end = html.indexOf("</main>", start);
  if (start < 0 || end < 0) throw new Error("Rendered page has no main element");
  return html.slice(start, end + "</main>".length);
}

function attribute(openingTag: string, name: string) {
  return openingTag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function renderedForm(html: string, action: string, fields: Record<string, string> = {}) {
  const actionIndex = html.indexOf(`action="${action}"`);
  if (actionIndex < 0) throw new Error(`Rendered page has no form for ${action}`);
  const start = html.lastIndexOf("<form", actionIndex);
  const end = html.indexOf(">", actionIndex);
  const openingTag = html.slice(start, end + 1);
  const classes = new Set((attribute(openingTag, "class") ?? "").split(/\s+/).filter(Boolean));

  return new TestHtmlFormElement(
    attribute(openingTag, "method") ?? "get",
    new URL(action, origin).href,
    classes,
    fields,
  );
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
    "HTMLButtonElement",
    "confirm",
    "fetch",
    "FormData",
    "DOMParser",
    "window",
    appSource,
  )(
    document,
    TestHtmlFormElement,
    TestHtmlButtonElement,
    confirm,
    fetch,
    TestFormData,
    TestDomParser,
    { location: { reload: () => reloads++ } },
  );

  if (!document.handler) throw new Error("Client script did not register a submit handler");
  return { document, submit: document.handler, reloads: () => reloads };
}

describe("browser shelf mutations", () => {
  test("adds the first book in place without navigating", async () => {
    const initialPage = page([]);
    const added = book(1, "Kindred");
    const requests: Array<{ url: string; options: { method: string; body: TestFormData } }> = [];
    const client = clientHarness(initialPage, async (url, options) => {
      requests.push({ url, options });
      return new Response(page([added]));
    });
    const form = renderedForm(initialPage, "/books", {
      title: added.title,
      author: added.author,
    });
    const event = new TestSubmitEvent(form, new TestHtmlButtonElement());

    await client.submit(event);

    expect(event.defaultPrevented).toBe(true);
    expect(client.reloads()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${origin}/books`);
    expect(requests[0]?.options.body.form.fields).toEqual({
      title: "Kindred",
      author: "Test Author",
    });
    expect(client.document.currentMain.markup).toContain("Kindred");
    expect(client.document.currentMain.markup).toContain("<b>0</b> of 1 read");
    expect(client.document.currentMain.markup).not.toContain("Your shelf is empty");
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
    const event = new TestSubmitEvent(form, new TestHtmlButtonElement());

    await client.submit(event);

    expect(event.defaultPrevented).toBe(true);
    expect(confirmations).toBe(1);
    expect(requests).toBe(0);
    expect(client.document.replacements).toEqual([]);
    expect(client.reloads()).toBe(0);
  });

  test("serializes overlapping mutations before installing their snapshots", async () => {
    const first = book(1, "Kindred");
    const second = book(2, "Dune");
    const initialPage = page([second, first]);
    const older = deferred<Response>();
    const newer = deferred<Response>();
    const requests: string[] = [];
    const client = clientHarness(initialPage, (url) => {
      requests.push(url);
      return url.endsWith("/toggle") ? older.promise : newer.promise;
    });
    const toggle = new TestSubmitEvent(
      renderedForm(initialPage, "/books/1/toggle"),
      new TestHtmlButtonElement(),
    );
    const remove = new TestSubmitEvent(
      renderedForm(initialPage, "/books/2/delete"),
      new TestHtmlButtonElement(),
    );

    const firstSubmission = client.submit(toggle);
    const secondSubmission = client.submit(remove);
    newer.resolve(new Response(page([{ ...first, read: true }])));
    await Promise.resolve();

    expect(requests).toEqual([`${origin}/books/1/toggle`]);

    older.resolve(new Response(page([second, { ...first, read: true }])));
    await firstSubmission;
    await secondSubmission;

    expect(requests).toEqual([
      `${origin}/books/1/toggle`,
      `${origin}/books/2/delete`,
    ]);
    expect(client.document.replacements[0]).toContain("<b>1</b> of 2 read");
    expect(client.document.currentMain.markup).toContain("<b>1</b> of 1 read");
    expect(client.document.currentMain.markup).not.toContain("Dune");
    expect(client.reloads()).toBe(0);
  });
});
