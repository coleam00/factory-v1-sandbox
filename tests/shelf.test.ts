import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";
import { page } from "../src/views";

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

    expect(body).toContain('aria-label="Mark Dune as read"');
    expect(body).toContain(
      'aria-label="Mark A &quot;Book&quot; &amp; &lt;More&gt; as unread"',
    );
    expect(body).toContain('aria-label="Mark The Left Hand of Darkness as read"');
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

  test("rejects titles that are empty after normalization", () => {
    const db = openShelf(":memory:");
    for (const title of ["", "   "]) {
      expect(() => db.add(title, "Nobody")).toThrow("Title is required.");
    }
    expect(db.list()).toEqual([]);
    db.close();
  });

  test("rejects legacy books with empty titles when listing", () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-legacy-title-"));
    try {
      for (const read of [0, 1]) {
        const path = join(directory, `read-${read}.db`);
        const current = openShelf(path);
        current.close();

        const legacy = new Database(path);
        legacy
          .query("INSERT INTO books (title, author, read) VALUES ('', 'Nobody', ?)")
          .run(read);
        legacy.close();

        const reopened = openShelf(path);
        expect(() => reopened.list()).toThrow("Stored book 1 has an empty title.");
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    expect(body).toContain('aria-label="Mark Dune as read"');
    expect(body).toContain("<b>0</b> of 1 read");

    await fetch(`${base}/books/1/toggle`, { method: "POST" });
    body = await (await fetch(base)).text();
    expect(body).toContain("<b>1</b> of 1 read");
    expect(body).toContain('aria-label="Mark Dune as unread"');

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
});
