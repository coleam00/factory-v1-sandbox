import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";

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
    app = startServer({ port: 0, dbPath: ":memory:" });
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
    expect(body).toContain('<input name="title" required');
    expect(body).toContain('<input name="author" required');
    expect(body).not.toMatch(/\bmaxlength\s*=/i);

    response = await addBook("Kindred", "Octavia E. Butler");
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
    const invalid = await addBook("   ", "Nobody");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Title and author are required");
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });

  test("accepts trimmed title and author fields at 200 characters", async () => {
    const title = "T".repeat(200);
    const author = "A".repeat(200);

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
        title: "T".repeat(201),
        author: "Valid author",
        message: "Title must be 200 characters or fewer.",
      },
      {
        title: "Valid title",
        author: "A".repeat(201),
        message: "Author must be 200 characters or fewer.",
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
