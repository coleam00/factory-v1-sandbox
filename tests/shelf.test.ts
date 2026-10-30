import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";

const originalRevision = process.env.APP_REVISION;

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

  beforeAll(() => {
    app = startWithRevision();
    base = app.server.url.origin;
  });
  afterAll(() => app.close());

  test("renders, creates, toggles, and deletes a book", async () => {
    let response = await fetch(base);
    let body = await response.text();
    expect(body).toContain("<b>0</b> of 0 read");
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

    response = await fetch(`${base}/books`, {
      method: "POST",
      body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");

    body = await (await fetch(base)).text();
    expect(body).toContain("Kindred");
    expect(body).toContain("<b>0</b> of 1 read");

    response = await fetch(`${base}/books/1/toggle`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    body = await (await fetch(base)).text();
    expect(body).toContain("<b>1</b> of 1 read");

    response = await fetch(`${base}/books/1/delete`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(await (await fetch(base)).text()).toContain("<b>0</b> of 0 read");
  });

  test("validates input and returns 404s", async () => {
    const invalid = await fetch(`${base}/books`, {
      method: "POST",
      body: new URLSearchParams({ title: "", author: "Nobody" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Title and author are required");
    expect((await fetch(`${base}/missing`)).status).toBe(404);
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
