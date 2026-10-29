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

class TestHtmlButtonElement {
  disabled = false;
}

class TestFormData {
  readonly fields: Record<string, string>;

  constructor(form: TestHtmlFormElement) {
    this.fields = Object.fromEntries(form.controls.map(({ name, value }) => [name, value]));
  }
}

class TestAlert {
  className = "";
  textContent = "";
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
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
  alert?: TestAlert;

  constructor(html: string) {
    this.currentMain = new TestMain(this, mainMarkup(html));
    this.alert = this.currentMain.alert;
  }

  addEventListener(type: string, handler: (event: TestSubmitEvent) => Promise<void>) {
    if (type === "submit") this.handler = handler;
  }

  querySelector(selector: string) {
    if (selector === "main") return this.currentMain;
    if (selector === 'main [role="alert"]') return this.alert ?? null;
    return null;
  }

  createElement(tag: string) {
    if (tag !== "p") throw new Error(`Unexpected element: ${tag}`);
    return new TestAlert();
  }

  page(html: string) {
    return {
      querySelector: (selector: string) =>
        selector === "main" ? new TestMain(this, mainMarkup(html)) : null,
    };
  }
}

class TestMain {
  readonly alert?: TestAlert;

  constructor(
    private readonly document: TestDocument,
    readonly markup: string,
  ) {
    const alertText = markup.match(/<p class="error" role="alert">([^<]*)<\/p>/)?.[1];
    if (alertText) {
      this.alert = new TestAlert();
      this.alert.className = "error";
      this.alert.setAttribute("role", "alert");
      this.alert.textContent = alertText;
    }
  }

  replaceWith(next: TestMain) {
    this.document.replacements.push(next.markup);
    this.document.currentMain = next;
    this.document.alert = next.alert;
  }

  prepend(element: TestAlert) {
    this.document.alert = element;
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
    const app = startServer({ port: 0, dbPath: ":memory:" });
    try {
      const initialPage = page([]);
      const requests: Array<{ url: string; options: { method: string; body: TestFormData } }> = [];
      const client = clientHarness(initialPage, async (url, options) => {
        requests.push({ url, options });
        return fetch(new URL(new URL(url).pathname, app.server.url), {
          method: options.method,
          body: new URLSearchParams(options.body.fields),
        });
      });
      const form = renderedForm(initialPage, "/books");
      form.setValue("Title", "Kindred");
      form.setValue("Author", "Octavia E. Butler");
      const event = new TestSubmitEvent(form, new TestHtmlButtonElement());

      await client.submit(event);

      expect(event.defaultPrevented).toBe(true);
      expect(client.reloads()).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${origin}/books`);
      expect(client.document.currentMain.markup).toContain("Kindred");
      expect(client.document.currentMain.markup).toContain("<b>0</b> of 1 read");
      expect(client.document.currentMain.markup).not.toContain("Your shelf is empty");
    } finally {
      app.close();
    }
  });

  test("freezes an add payload when it joins the mutation queue", async () => {
    const existing = book(1, "Kindred");
    const initialPage = page([existing]);
    const firstResponse = deferred<Response>();
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const client = clientHarness(initialPage, (url, options) => {
      requests.push({ url, body: options.body.fields });
      return url.endsWith("/toggle")
        ? firstResponse.promise
        : Promise.resolve(new Response(page([book(2, "Submitted title"), existing])));
    });
    const toggle = new TestSubmitEvent(
      renderedForm(initialPage, "/books/1/toggle"),
      new TestHtmlButtonElement(),
    );
    const addForm = renderedForm(initialPage, "/books");
    addForm.setValue("Title", "Submitted title");
    addForm.setValue("Author", "Submitted author");
    const add = new TestSubmitEvent(addForm, new TestHtmlButtonElement());

    const firstSubmission = client.submit(toggle);
    const addSubmission = client.submit(add);
    addForm.setValue("Title", "Edited after submit");
    addForm.setValue("Author", "Edited author");
    firstResponse.resolve(new Response(page([existing])));
    await firstSubmission;
    await addSubmission;

    expect(requests).toEqual([
      { url: `${origin}/books/1/toggle`, body: {} },
      {
        url: `${origin}/books`,
        body: { title: "Submitted title", author: "Submitted author" },
      },
    ]);
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

  test("keeps the form and shows an actionable error when a mutation cannot be confirmed", async () => {
    const initialPage = page([]);
    const client = clientHarness(initialPage, async () => {
      throw new Error("network unavailable");
    });
    const form = renderedForm(initialPage, "/books");
    form.setValue("Title", "Kindred");
    form.setValue("Author", "Octavia E. Butler");
    const submitter = new TestHtmlButtonElement();

    await client.submit(new TestSubmitEvent(form, submitter));

    expect(submitter.disabled).toBe(false);
    expect(form.controls.map(({ label, value }) => [label, value])).toEqual([
      ["Title", "Kindred"],
      ["Author", "Octavia E. Butler"],
    ]);
    expect(client.document.currentMain.markup).toBe(mainMarkup(initialPage));
    expect(client.document.alert?.className).toBe("error");
    expect(client.document.alert?.attributes.get("role")).toBe("alert");
    expect(client.document.alert?.textContent).toBe(
      "Shelf could not confirm that change. Check your shelf before trying again.",
    );
    expect(client.reloads()).toBe(0);
  });
});
