import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";
import { page } from "../src/views";

const toggleForm = (body: string, bookId: number) => {
  const form = body.match(
    new RegExp(`<form\\b(?=[^>]*\\baction="/books/${bookId}/toggle")[^>]*>[\\s\\S]*?</form>`),
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
        id: 1,
        title: "Dune",
        author: "Frank Herbert",
        read: false,
        createdAt: "2026-10-29 00:00:00",
      },
      {
        id: 2,
        title: 'A "Book" & <More>',
        author: "Another Author",
        read: true,
        createdAt: "2026-10-29 00:00:00",
      },
      {
        id: 3,
        title: "The Left Hand of Darkness",
        author: "Ursula K. Le Guin",
        read: false,
        createdAt: "2026-10-29 00:00:00",
      },
    ]);

    expect(toggleForm(body, 1)).toContain('aria-label="Mark Dune as read (book 1)"');
    expect(toggleForm(body, 2)).toContain(
      'aria-label="Mark A &quot;Book&quot; &amp; &lt;More&gt; as unread (book 2)"',
    );
    expect(toggleForm(body, 3)).toContain(
      'aria-label="Mark The Left Hand of Darkness as read (book 3)"',
    );
  });
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
    app = startServer({ port: 0, dbPath: ":memory:" });
    base = app.server.url.origin;
  });
  afterAll(() => app.close());

  test("renders, creates, toggles, and deletes a book", async () => {
    let response = await fetch(base);
    expect(await response.text()).toContain("<b>0</b> of 0 read");

    response = await fetch(`${base}/books`, {
      method: "POST",
      body: new URLSearchParams({ title: "Dune", author: "Frank Herbert" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);

    let body = await (await fetch(base)).text();
    expect(body).toContain("Dune");
    expect(body).toContain('aria-label="Mark Dune as read (book 1)"');
    expect(body).toContain("<b>0</b> of 1 read");

    await fetch(`${base}/books/1/toggle`, { method: "POST" });
    body = await (await fetch(base)).text();
    expect(body).toContain("<b>1</b> of 1 read");
    expect(body).toContain('aria-label="Mark Dune as unread (book 1)"');

    await fetch(`${base}/books/1/delete`, { method: "POST" });
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
      const firstName = ariaLabel(toggleForm(body, 1));
      const secondName = ariaLabel(toggleForm(body, 2));
      expect(firstName).toBe("Mark A B as read (book 1)");
      expect(secondName).toBe("Mark A  B as read (book 2)");
      expect(firstName.replace(/\s+/g, " ")).not.toBe(secondName.replace(/\s+/g, " "));
    } finally {
      whitespaceApp.close();
    }
  });
});
