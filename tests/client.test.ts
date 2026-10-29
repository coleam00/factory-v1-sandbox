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
  readonly elements = {
    namedItem: (name: string) => this.controls.find((control) => control.name === name) ?? null,
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

  entries() {
    return Object.entries(this.fields)[Symbol.iterator]();
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
    if (selector === "form.add") return this.currentMain.addForm;
    return null;
  }

  createElement(tag: string) {
    if (tag !== "p") throw new Error(`Unexpected element: ${tag}`);
    return new TestAlert();
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
  readonly alert?: TestAlert;
  readonly addForm: TestHtmlFormElement;

  constructor(
    private readonly document: TestDocument,
    readonly markup: string,
  ) {
    this.addForm = renderedForm(markup, "/books");
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

  test("keeps an unconfirmed result visible after a queued mutation succeeds", async () => {
    const existing = book(1, "Dune");
    const initialPage = page([existing]);
    const client = clientHarness(initialPage, (url) =>
      url.endsWith("/books")
        ? Promise.reject(new Error("network unavailable"))
        : Promise.resolve(new Response(page([]))),
    );
    const addForm = renderedForm(initialPage, "/books");
    addForm.setValue("Title", "Parable of the Sower");
    addForm.setValue("Author", "Octavia E. Butler");

    const failedAdd = client.submit(
      new TestSubmitEvent(addForm, new TestHtmlButtonElement()),
    );
    const successfulDelete = client.submit(
      new TestSubmitEvent(
        renderedForm(initialPage, "/books/1/delete"),
        new TestHtmlButtonElement(),
      ),
    );
    await failedAdd;
    await successfulDelete;

    expect(client.document.currentMain.markup).not.toContain("Dune");
    expect(
      client.document.currentMain.addForm.controls.map(({ label, value }) => [label, value]),
    ).toEqual([
      ["Title", "Parable of the Sower"],
      ["Author", "Octavia E. Butler"],
    ]);
    expect(client.document.alert?.textContent).toBe(
      "Shelf could not confirm that change. Check your shelf before trying again.",
    );
    expect(client.reloads()).toBe(0);
  });

  test("restores a queued add after an earlier mutation replaces its form", async () => {
    const existing = book(1, "Kindred");
    const initialPage = page([existing]);
    const client = clientHarness(initialPage, (url) =>
      url.endsWith("/toggle")
        ? Promise.resolve(new Response(page([{ ...existing, read: true }])))
        : Promise.reject(new Error("network unavailable")),
    );
    const addForm = renderedForm(initialPage, "/books");
    addForm.setValue("Title", "Parable of the Sower");
    addForm.setValue("Author", "Octavia E. Butler");

    const successfulToggle = client.submit(
      new TestSubmitEvent(
        renderedForm(initialPage, "/books/1/toggle"),
        new TestHtmlButtonElement(),
      ),
    );
    const failedAdd = client.submit(
      new TestSubmitEvent(addForm, new TestHtmlButtonElement()),
    );
    await successfulToggle;
    await failedAdd;

    expect(
      client.document.currentMain.addForm.controls.map(({ label, value }) => [label, value]),
    ).toEqual([
      ["Title", "Parable of the Sower"],
      ["Author", "Octavia E. Butler"],
    ]);
    expect(client.document.alert?.textContent).toBe(
      "Shelf could not confirm that change. Check your shelf before trying again.",
    );
  });

  test("shows the mutation error when a response has no page content", async () => {
    const initialPage = page([book(1, "Kindred")]);
    const submitter = new TestHtmlButtonElement();
    const client = clientHarness(initialPage, async () => new Response("Not a shelf page"));

    await client.submit(
      new TestSubmitEvent(renderedForm(initialPage, "/books/1/toggle"), submitter),
    );

    expect(submitter.disabled).toBe(false);
    expect(client.document.replacements).toEqual([]);
    expect(client.document.alert?.textContent).toBe(
      "Shelf could not confirm that change. Check your shelf before trying again.",
    );
    expect(client.reloads()).toBe(0);
  });

  test("updates the server-rendered alert as the client mutation error", async () => {
    const initialPage = page([], "Title and author are required.");
    const client = clientHarness(initialPage, async () => {
      throw new Error("network unavailable");
    });
    const serverAlert = client.document.alert;

    await client.submit(
      new TestSubmitEvent(renderedForm(initialPage, "/books"), new TestHtmlButtonElement()),
    );

    expect(client.document.alert).toBe(serverAlert);
    expect(serverAlert?.className).toBe("error");
    expect(serverAlert?.attributes.get("role")).toBe("alert");
    expect(serverAlert?.textContent).toBe(
      "Shelf could not confirm that change. Check your shelf before trying again.",
    );
  });
});
