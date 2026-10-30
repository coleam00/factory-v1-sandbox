import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxBookFieldLength } from "../src/book-fields";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";
import { page } from "../src/views";

const toggleForm = (body: string, bookId: bigint) => {
  const form = body.match(
    new RegExp(
      `<form\\b(?=[^>]*\\baction="/books/${bookId}/toggle(?:\\?[^\"]*)?")[^>]*>[\\s\\S]*?</form>`,
    ),
  )?.[0];
  if (!form) throw new Error(`Missing toggle form for book ${bookId}`);
  return form;
};

const ariaLabel = (element: string) => {
  const label = element.match(/\baria-label="([^"]*)"/)?.[1];
  if (!label) throw new Error("Missing aria-label");
  return label;
};

describe("page", () => {
  test("names each read toggle for its book and next action", () => {
    const body = page([
      {
        id: 1n,
        title: "Dune",
        author: "Frank Herbert",
        read: false,
        createdAt: "2026-10-29 00:00:00",
      },
      {
        id: 2n,
        title: 'A "Book" & <More>',
        author: "Another Author",
        read: true,
        createdAt: "2026-10-29 00:00:00",
      },
      {
        id: 3n,
        title: "The Left Hand of Darkness",
        author: "Ursula K. Le Guin",
        read: false,
        createdAt: "2026-10-29 00:00:00",
      },
    ], { filter: "all", order: "added" });

    expect(toggleForm(body, 1n)).toContain('aria-label="Mark Dune as read (book 1)"');
    expect(toggleForm(body, 2n)).toContain(
      'aria-label="Mark A &quot;Book&quot; &amp; &lt;More&gt; as unread (book 2)"',
    );
    expect(toggleForm(body, 3n)).toContain(
      'aria-label="Mark The Left Hand of Darkness as read (book 3)"',
    );
  });
});

const originalRevision = process.env.APP_REVISION;

function tagForNamedInput(body: string, name: string) {
  return body.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0];
}

function attribute(tag: string | undefined, name: string) {
  return tag?.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
}

function startWithRevision(revision?: string) {
  if (revision === undefined) delete process.env.APP_REVISION;
  else process.env.APP_REVISION = revision;

  try {
    return startServer({ port: 0, dbPath: ":memory:" });
  } finally {
    if (originalRevision === undefined) delete process.env.APP_REVISION;
    else process.env.APP_REVISION = originalRevision;
  }
}

async function readActiveSkipLinkEndpoints(body: string) {
  const skipLinks: { href: string | null; text: string }[] = [];
  const idOwners: {
    id: string;
    tagName: string;
    tabindex: string | null;
  }[] = [];
  let templateDepth = 0;
  let currentSkipLink: (typeof skipLinks)[number] | undefined;

  const parsedBody = new HTMLRewriter()
    .on("template", {
      element(element) {
        templateDepth += 1;
        element.onEndTag(() => templateDepth -= 1);
      },
    })
    .on("a.skip-link", {
      element(element) {
        if (templateDepth > 0) return;
        currentSkipLink = { href: element.getAttribute("href"), text: "" };
        skipLinks.push(currentSkipLink);
        element.onEndTag(() => currentSkipLink = undefined);
      },
      text(text) {
        if (templateDepth === 0 && currentSkipLink) {
          currentSkipLink.text += text.text;
        }
      },
    })
    .on("[id]", {
      element(element) {
        if (templateDepth > 0) return;
        const id = element.getAttribute("id");
        if (id === null) return;
        idOwners.push({
          id,
          tagName: element.tagName,
          tabindex: element.getAttribute("tabindex"),
        });
      },
    })
    .transform(new Response(body));
  await parsedBody.text();

  return { skipLinks, idOwners };
}

async function readActiveTargetHeadings(body: string, targetId: string) {
  const headings: string[] = [];
  let templateDepth = 0;
  let currentHeading = -1;

  const parsedBody = new HTMLRewriter()
    .on("template", {
      element(element) {
        templateDepth += 1;
        element.onEndTag(() => templateDepth -= 1);
      },
    })
    .on(`[id="${targetId}"] h2`, {
      element(element) {
        if (templateDepth > 0) return;
        currentHeading = headings.push("") - 1;
        element.onEndTag(() => currentHeading = -1);
      },
      text(text) {
        if (templateDepth === 0 && currentHeading >= 0) {
          headings[currentHeading] += text.text;
        }
      },
    })
    .transform(new Response(body));
  await parsedBody.text();

  return headings;
}

test("structural reader excludes inert template endpoints and label text", async () => {
  const body = `<template><a class="skip-link" href="#books">Skip to books</a></template>
    <a class="skip-link" href="#books">Skip <template>nowhere </template>to books</a>
    <template><section id="books" tabindex="-1"><h2>Books</h2></section></template>
    <section id="books" tabindex="-1"><h2>Books<template> nowhere</template></h2></section>`;

  const { skipLinks, idOwners } = await readActiveSkipLinkEndpoints(body);
  expect(skipLinks).toEqual([{ href: "#books", text: "Skip to books" }]);
  expect(idOwners).toEqual([{ id: "books", tagName: "section", tabindex: "-1" }]);
  expect(await readActiveTargetHeadings(body, "books")).toEqual(["Books"]);
});

describe("database", () => {
  test("adds, lists, toggles, and deletes books", () => {
    const db = openShelf(":memory:");
    const id = db.add("Dune", "Frank Herbert");
    expect(db.list()).toMatchObject([{ id, title: "Dune", author: "Frank Herbert", read: false }]);
    expect(db.toggle(id)).toBe(true);
    expect(db.list()[0]?.read).toBe(true);
    expect(db.remove(id)).toBe(true);
    expect(db.list()).toEqual([]);
    db.close();
  });
});

describe("HTTP routes", () => {
  let app: ReturnType<typeof startServer>;
  let base: string;

  beforeEach(() => {
    app = startWithRevision();
    base = app.server.url.origin;
  });
  afterEach(() => app.close());

  const addBook = (title: string, author: string) =>
    fetch(`${base}/books`, {
      method: "POST",
      body: new URLSearchParams({ title, author }),
      redirect: "manual",
    });

  test("renders, creates, toggles, and deletes a book", async () => {
    let response = await fetch(base);
    let body = await response.text();
    expect(body).toContain("<b>0</b> of 0 read");
    expect(body).toContain(
      `Title and author can each be up to ${maxBookFieldLength} characters after trimming.`,
    );
    const guidanceId = body.match(/<p class="add-guidance" id="([^"]+)">/)?.[1];
    expect(guidanceId).toBeTruthy();
    for (const field of ["title", "author"]) {
      expect(attribute(tagForNamedInput(body, field), "aria-describedby")).toBe(guidanceId);
    }
    expect(body).not.toMatch(/\bmaxlength\s*=/i);

    const { skipLinks, idOwners } = await readActiveSkipLinkEndpoints(body);
    expect(skipLinks).toHaveLength(1);
    expect(skipLinks[0]!.text.trim()).toBe("Skip to books");
    expect(skipLinks[0]!.href?.[0]).toBe("#");
    const targetId = decodeURIComponent(skipLinks[0]!.href!.slice(1));
    const targetOwners = idOwners.filter(({ id }) => id === targetId);
    expect(targetOwners).toHaveLength(1);
    expect(targetOwners[0]).toMatchObject({
      tagName: "section",
      tabindex: "-1",
    });

    const targetHeadings = await readActiveTargetHeadings(body, targetId);
    expect(targetHeadings.map((heading) => heading.trim())).toEqual(["Books"]);

    response = await addBook("Dune", "Frank Herbert");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");

    body = await (await fetch(base)).text();
    expect(body).toContain("Dune");
    expect(body).toContain('aria-label="Mark Dune as read (book 1)"');
    expect(body).toContain("<b>0</b> of 1 read");

    response = await fetch(`${base}/books/1/toggle`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    body = await (await fetch(base)).text();
    expect(body).toContain("<b>1</b> of 1 read");
    expect(body).toContain('aria-label="Mark Dune as unread (book 1)"');

    response = await fetch(`${base}/books/1/delete`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(await (await fetch(base)).text()).toContain("<b>0</b> of 0 read");
  });

  test("validates input and returns 404s", async () => {
    for (const [title, author] of [
      ["   ", "Nobody"],
      ["Dune", "   "],
    ]) {
      const invalid = await addBook(title, author);
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("Title and author are required");
      expect(await (await fetch(base)).text()).toContain("<b>0</b> of 0 read");
    }
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });

  test("accepts trimmed title and author fields at 200 characters", async () => {
    expect(maxBookFieldLength).toBe(200);
    const title = "T".repeat(maxBookFieldLength);
    const author = "A".repeat(maxBookFieldLength);

    const response = await addBook(` ${title} `, ` ${author} `);
    expect(response.status).toBe(303);

    const body = await (await fetch(base)).text();
    expect(body).toContain(`<strong>${title}</strong>`);
    expect(body).toContain(`<span>${author}</span>`);
    expect(body).toContain("<b>0</b> of 1 read");
  });

  test("rejects overlong fields without changing the shelf", async () => {
    expect((await addBook("Dune", "Frank Herbert")).status).toBe(303);
    const activeView = "filter=all&order=title";

    const attempts = [
      {
        title: "T".repeat(maxBookFieldLength + 1),
        author: "Valid author",
        message: `Title must be ${maxBookFieldLength} characters or fewer.`,
      },
      {
        title: "Valid title",
        author: "A".repeat(maxBookFieldLength + 1),
        message: `Author must be ${maxBookFieldLength} characters or fewer.`,
      },
    ];

    for (const attempt of attempts) {
      const response = await fetch(`${base}/books?${activeView}`, {
        method: "POST",
        body: new URLSearchParams({ title: attempt.title, author: attempt.author }),
      });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain(attempt.message);
      expect(body).toContain("Dune");
      expect(body).toContain("<b>0</b> of 1 read");
      expect(body).toContain('action="/books?filter=all&amp;order=title"');
    }

    const body = await (await fetch(base)).text();
    expect(body).toContain("Dune");
    expect(body).toContain("<b>0</b> of 1 read");
  });

  test("rejects repeated and file-valued book fields without changing the shelf", async () => {
    expect((await addBook("Dune", "Frank Herbert")).status).toBe(303);
    const shelfBefore = await (await fetch(base)).text();

    for (const field of ["title", "author"] as const) {
      const label = field === "title" ? "Title" : "Author";
      for (const representation of ["repeated", "file"] as const) {
        const form = new FormData();
        form.append(field === "title" ? "author" : "title", "Valid text");
        if (representation === "repeated") {
          form.append(field, "Valid text");
          form.append(field, "X".repeat(maxBookFieldLength + 1));
        } else {
          form.append(field, new Blob(["File contents"]), `${field}.txt`);
        }

        const response = await fetch(`${base}/books`, {
          method: "POST",
          body: form,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(
          `${label} must be submitted exactly once as text.`,
        );
        expect(await (await fetch(base)).text()).toBe(shelfBefore);
      }
    }
  });

  test("returns 404 for mutation requests with ids outside SQLite's range", async () => {
    const firstExcludedId = 9223372036854775808n;

    for (const action of ["toggle", "delete"] as const) {
      const response = await fetch(`${base}/books/${firstExcludedId}/${action}`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Book not found.");
    }

    expect((await fetch(base)).status).toBe(200);
  });

  test("toggles a book at SQLite's maximum id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-maximum-book-id-"));
    const dbPath = join(directory, "shelf.db");
    const maximumId = 9223372036854775807n;
    const shelf = openShelf(dbPath);
    shelf.close();

    const seed = new Database(dbPath, { safeIntegers: true });
    seed.query("INSERT INTO books (id, title, author) VALUES (?, ?, ?)")
      .run(maximumId, "Maximum Book", "Boundary Author");
    seed.close();

    const maximumIdApp = startServer({ port: 0, dbPath });
    const maximumIdBase = maximumIdApp.server.url.origin;

    try {
      let body = await (await fetch(maximumIdBase)).text();
      expect(ariaLabel(toggleForm(body, maximumId))).toBe(
        `Mark Maximum Book as read (book ${maximumId})`,
      );

      const response = await fetch(`${maximumIdBase}/books/${maximumId}/toggle`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(303);

      body = await (await fetch(maximumIdBase)).text();
      expect(ariaLabel(toggleForm(body, maximumId))).toBe(
        `Mark Maximum Book as unread (book ${maximumId})`,
      );
    } finally {
      maximumIdApp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns 404 without changing the shelf when a book is missing", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    const base = app.server.url.origin;
    const activeView = "filter=all&order=title";

    try {
      await fetch(`${base}/books`, {
        method: "POST",
        body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }),
      });
      const shelfBefore = await (await fetch(`${base}/?${activeView}`)).text();

      for (const action of ["toggle", "delete"] as const) {
        const response = await fetch(`${base}/books/999/${action}?${activeView}`, {
          method: "POST",
          redirect: "manual",
        });

        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).toContain("Book not found.");
        expect(body).toContain('<option value="all" selected>');
        expect(body).toContain('<option value="title" selected>');
        expect(await (await fetch(`${base}/?${activeView}`)).text()).toBe(shelfBefore);
      }
    } finally {
      app.close();
    }
  });

  test("keeps whitespace-distinct book toggle names distinguishable", async () => {
    const whitespaceApp = startServer({ port: 0, dbPath: ":memory:" });
    const whitespaceBase = whitespaceApp.server.url.origin;

    try {
      for (const title of ["A B", "A  B"]) {
        const response = await fetch(`${whitespaceBase}/books`, {
          method: "POST",
          body: new URLSearchParams({ title, author: "An Author" }),
          redirect: "manual",
        });
        expect(response.status).toBe(303);
      }

      const body = await (await fetch(whitespaceBase)).text();
      const firstName = ariaLabel(toggleForm(body, 1n));
      const secondName = ariaLabel(toggleForm(body, 2n));
      expect(firstName).toBe("Mark A B as read (book 1)");
      expect(secondName).toBe("Mark A  B as read (book 2)");
      expect(firstName.replace(/\s+/g, " ")).not.toBe(secondName.replace(/\s+/g, " "));
    } finally {
      whitespaceApp.close();
    }
  });

  test("preserves adjacent 64-bit book ids through rendering and mutations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-book-id-"));
    const dbPath = join(directory, "shelf.db");
    const firstId = 9007199254740992n;
    const secondId = 9007199254740993n;
    const shelf = openShelf(dbPath);
    shelf.close();

    const seed = new Database(dbPath, { safeIntegers: true });
    const insert = seed.query(
      "INSERT INTO books (id, title, author) VALUES (?, ?, ?)",
    );
    insert.run(firstId, "A B", "First Author");
    insert.run(secondId, "A  B", "Second Author");
    seed.close();

    const exactShelf = openShelf(dbPath);
    try {
      const addedId = exactShelf.add("Next Book", "Third Author");
      expect(addedId).toBe(9007199254740994n);
      expect(exactShelf.remove(addedId)).toBe(true);
    } finally {
      exactShelf.close();
    }

    const boundaryApp = startServer({ port: 0, dbPath });
    const boundaryBase = boundaryApp.server.url.origin;

    try {
      let body = await (await fetch(boundaryBase)).text();
      const firstName = ariaLabel(toggleForm(body, firstId));
      const secondName = ariaLabel(toggleForm(body, secondId));
      expect(firstName).toBe(
        "Mark A B as read (book 9007199254740992)",
      );
      expect(secondName).toBe(
        "Mark A  B as read (book 9007199254740993)",
      );
      expect(firstName.replace(/\s+/g, " ")).not.toBe(secondName.replace(/\s+/g, " "));
      expect(body).toContain(`/books/${firstId}/delete`);
      expect(body).toContain(`/books/${secondId}/delete`);

      await fetch(`${boundaryBase}/books/${secondId}/toggle`, { method: "POST" });
      body = await (await fetch(boundaryBase)).text();
      expect(ariaLabel(toggleForm(body, firstId))).toContain(" as read ");
      expect(ariaLabel(toggleForm(body, secondId))).toContain(" as unread ");

      const deleteResponse = await fetch(`${boundaryBase}/books/${secondId}/delete`, {
        method: "POST",
        redirect: "manual",
      });
      expect(deleteResponse.status).toBe(303);
      body = await (await fetch(boundaryBase)).text();
      expect(body).not.toContain(`/books/${secondId}/toggle`);
      expect(ariaLabel(toggleForm(body, firstId))).toContain(" as read ");
    } finally {
      boundaryApp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("shelf view", () => {
  test("retains each view field independently through mutation redirects", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    const base = app.server.url.origin;
    const cases = [
      ["filter=unread", "/?filter=unread&order=added"],
      ["order=title", "/?filter=all&order=title"],
    ] as const;

    try {
      for (const [query, location] of cases) {
        const response = await fetch(`${base}/books?${query}`, {
          method: "POST",
          body: new URLSearchParams({ title: query, author: "View tester" }),
          redirect: "manual",
        });

        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(location);
      }
    } finally {
      app.close();
    }
  });

  test("filters, orders, and retains the active view through mutations", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    const base = app.server.url.origin;
    const activeView = "filter=unread&order=title";
    const activeLocation = `/?${activeView}`;
    const postBook = (title: string) =>
      fetch(`${base}/books`, {
        method: "POST",
        body: new URLSearchParams({ title, author: `${title} author` }),
        redirect: "manual",
      });

    try {
      await postBook("Zebra");
      await postBook("apple");
      await postBook("Middle");

      const defaultBody = await (await fetch(base)).text();
      expect(defaultBody.indexOf("Middle")).toBeLessThan(defaultBody.indexOf("apple"));
      expect(defaultBody.indexOf("apple")).toBeLessThan(defaultBody.indexOf("Zebra"));

      const fallbackBody = await (
        await fetch(`${base}/?filter=unsupported&order=unsupported&ignored=value`)
      ).text();
      expect(fallbackBody).toContain('<option value="all" selected>');
      expect(fallbackBody).toContain('<option value="added" selected>');
      expect(fallbackBody).not.toContain("ignored=value");

      for (const field of ["filter", "order"] as const) {
        const response = await fetch(`${base}/?${field}=toString`);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('<option value="all" selected>');
        expect(body).toContain('<option value="added" selected>');
        expect(body).toContain('action="/books?filter=all&amp;order=added"');
      }

      const titleBody = await (await fetch(`${base}/?order=title`)).text();
      expect(titleBody.indexOf("apple")).toBeLessThan(titleBody.indexOf("Middle"));
      expect(titleBody.indexOf("Middle")).toBeLessThan(titleBody.indexOf("Zebra"));

      await fetch(`${base}/books/2/toggle`, { method: "POST" });
      let activeBody = await (await fetch(`${base}/?${activeView}`)).text();
      expect(activeBody).not.toContain("apple");
      expect(activeBody).toContain('<option value="unread" selected>');
      expect(activeBody).toContain('<option value="title" selected>');
      expect(activeBody).toContain('action="/books?filter=unread&amp;order=title"');
      expect(activeBody).toContain('action="/books/3/toggle?filter=unread&amp;order=title"');
      expect(activeBody).toContain("<b>1</b> of 3 read");
      expect(await (await fetch(`${base}/?${activeView}`)).text()).toBe(activeBody);

      let response = await fetch(`${base}/books?${activeView}`, {
        method: "POST",
        body: new URLSearchParams({ title: "", author: "Nobody" }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('action="/books?filter=unread&amp;order=title"');

      response = await fetch(`${base}/books?${activeView}`, {
        method: "POST",
        body: new URLSearchParams({ title: "Beginning", author: "New author" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(activeLocation);
      activeBody = await (await fetch(new URL(activeLocation, base))).text();
      expect(activeBody.indexOf("Beginning")).toBeLessThan(activeBody.indexOf("Middle"));

      response = await fetch(`${base}/books/4/toggle?${activeView}`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(activeLocation);
      activeBody = await (await fetch(new URL(activeLocation, base))).text();
      expect(activeBody).not.toContain("Beginning");

      response = await fetch(`${base}/books/3/delete?${activeView}`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(activeLocation);
      activeBody = await (await fetch(new URL(activeLocation, base))).text();
      expect(activeBody).not.toContain("Middle");

      await fetch(`${base}/books/1/toggle`, { method: "POST" });
      expect(await (await fetch(`${base}/?filter=unread`)).text()).toContain("No unread books.");
      expect(await (await fetch(`${base}/?filter=all`)).text()).toContain("Zebra");
    } finally {
      app.close();
    }
  });
});

describe("health", () => {
  test("reports an absent revision without changing a populated shelf", async () => {
    const app = startWithRevision();

    try {
      const created = await fetch(new URL("/books", app.server.url), {
        method: "POST",
        body: new URLSearchParams({ title: "Parable of the Sower", author: "Octavia E. Butler" }),
        redirect: "manual",
      });
      expect(created.status).toBe(303);
      const before = await (await fetch(app.server.url)).text();
      expect(before).toContain("Parable of the Sower");
      const response = await fetch(new URL("/health", app.server.url));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(await response.json()).toEqual({ status: "ok", revision: null });
      expect(await (await fetch(app.server.url)).text()).toBe(before);
    } finally {
      app.close();
    }
  });

  test("normalizes a configured full revision", async () => {
    const app = startWithRevision("ABCDEF0123456789ABCDEF0123456789ABCDEF01");

    try {
      const response = await fetch(new URL("/health", app.server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ok",
        revision: "abcdef0123456789abcdef0123456789abcdef01",
      });
    } finally {
      app.close();
    }
  });

  test("rejects a full-length non-hexadecimal revision", async () => {
    const app = startWithRevision("g".repeat(40));

    try {
      const response = await fetch(new URL("/health", app.server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", revision: null });
    } finally {
      app.close();
    }
  });

  test("rejects whitespace around a full revision", async () => {
    const app = startWithRevision(" 0123456789abcdef0123456789abcdef01234567");

    try {
      const response = await fetch(new URL("/health", app.server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", revision: null });
    } finally {
      app.close();
    }
  });

  test("preserves a configured lowercase full revision", async () => {
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const app = startWithRevision(revision);

    try {
      const response = await fetch(new URL("/health", app.server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", revision });
    } finally {
      app.close();
    }
  });

  test.each([39, 41])("rejects a %i-character hexadecimal revision", async length => {
    const app = startWithRevision("a".repeat(length));

    try {
      const response = await fetch(new URL("/health", app.server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", revision: null });
    } finally {
      app.close();
    }
  });
});
