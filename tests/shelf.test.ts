import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";

describe("database", () => {
  test("adds, lists, toggles, and deletes books", () => {
    const db = openShelf(":memory:");
    const id = db.add("Dune", "Frank Herbert");
    expect(typeof id).toBe("bigint");
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
      body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);

    let body = await (await fetch(base)).text();
    expect(body).toContain("Kindred");
    expect(body).toContain("<b>0</b> of 1 read");

    await fetch(`${base}/books/1/toggle`, { method: "POST" });
    body = await (await fetch(base)).text();
    expect(body).toContain("<b>1</b> of 1 read");

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

  test("handles the complete SQLite ID range in mutation routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-routes-"));
    const dbPath = join(directory, "shelf.db");
    const minimumId = -9_223_372_036_854_775_808n;
    const maximumId = 9_223_372_036_854_775_807n;
    const outOfRangeIds = [minimumId - 1n, maximumId + 1n];
    const setup = openShelf(dbPath);
    setup.close();

    const seed = new Database(dbPath, { safeIntegers: true });
    seed
      .query("INSERT INTO books (id, title, author) VALUES (?, ?, ?)")
      .run(minimumId, "Minimum", "Identifier");
    seed
      .query("INSERT INTO books (id, title, author) VALUES (?, ?, ?)")
      .run(maximumId, "Maximum", "Identifier");
    seed.close();

    const signedApp = startServer({ port: 0, dbPath });
    const signedBase = signedApp.server.url.origin;
    try {
      const body = await (await fetch(signedBase)).text();
      expect(body).toContain(`/books/${minimumId}/toggle`);
      expect(body).toContain(`/books/${maximumId}/delete`);

      for (const id of outOfRangeIds) {
        for (const action of ["toggle", "delete"]) {
          const response = await fetch(`${signedBase}/books/${id}/${action}`, {
            method: "POST",
            redirect: "manual",
          });
          expect(response.status).toBe(303);
        }
      }

      for (const id of [minimumId, maximumId]) {
        let response = await fetch(`${signedBase}/books/${id}/toggle`, {
          method: "POST",
          redirect: "manual",
        });
        expect(response.status).toBe(303);

        const inspection = new Database(dbPath, { readonly: true, safeIntegers: true });
        expect(inspection.query("SELECT read FROM books WHERE id = ?").get(id)).toEqual({
          read: 1n,
        });
        inspection.close();

        response = await fetch(`${signedBase}/books/${id}/delete`, {
          method: "POST",
          redirect: "manual",
        });
        expect(response.status).toBe(303);
      }

      const inspection = new Database(dbPath, { readonly: true, safeIntegers: true });
      expect(inspection.query("SELECT id FROM books").all()).toEqual([]);
      inspection.close();
    } finally {
      signedApp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("JSON export", () => {
  test("downloads an empty shelf", async () => {
    const app = startServer({ port: 0, dbPath: ":memory:" });
    try {
      const response = await fetch(`${app.server.url.origin}/books/export.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="shelf.json"',
      );
      expect(await response.text()).toBe("[]");
    } finally {
      app.close();
    }
  });

  test("exports an existing shelf exactly without changing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-export-"));
    const dbPath = join(directory, "shelf.db");
    const first = {
      id: 9_007_199_254_740_992n,
      title: 'A <Shelf> & "Stories"',
      author: "Anne O'Writer",
      read: 0,
    };
    const second = {
      id: 9_007_199_254_740_993n,
      title: "Second Book",
      author: "Another Author",
      read: 1,
    };
    const seed = new Database(dbPath, { create: true, safeIntegers: true });
    seed.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insert = seed.query(
      "INSERT INTO books (id, title, author, read) VALUES (?, ?, ?, ?)",
    );
    insert.run(first.id, first.title, first.author, first.read);
    insert.run(second.id, second.title, second.author, second.read);
    const schemaBefore = seed
      .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    const booksBefore = seed.query("SELECT * FROM books ORDER BY id").all();
    seed.close();

    const app = startServer({ port: 0, dbPath });
    const base = app.server.url.origin;
    try {
      const pageBody = await (await fetch(base)).text();
      expect(pageBody.indexOf(second.title)).toBeLessThan(pageBody.indexOf("A &lt;Shelf&gt;"));
      expect(pageBody).toContain(`/books/${first.id}/toggle`);
      expect(pageBody).toContain(`/books/${second.id}/delete`);

      const response = await fetch(`${base}/books/export.json?filter=unread`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="shelf.json"',
      );
      const raw = await response.text();
      expect(raw).toBe(
        `[{"id":${first.id},"title":${JSON.stringify(first.title)},"author":${JSON.stringify(first.author)},"read":false},` +
          `{"id":${second.id},"title":${JSON.stringify(second.title)},"author":${JSON.stringify(second.author)},"read":true}]`,
      );
      expect(JSON.parse(raw)).toHaveLength(2);

      const inspection = new Database(dbPath, { readonly: true, safeIntegers: true });
      expect(
        inspection
          .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
      ).toEqual(schemaBefore);
      expect(inspection.query("SELECT * FROM books ORDER BY id").all()).toEqual(booksBefore);

      await fetch(`${base}/books/${first.id}/toggle`, { method: "POST", redirect: "manual" });
      expect(inspection.query("SELECT read FROM books WHERE id = ?").get(first.id)).toEqual({
        read: 1n,
      });
      expect(inspection.query("SELECT read FROM books WHERE id = ?").get(second.id)).toEqual({
        read: 1n,
      });

      await fetch(`${base}/books/${second.id}/delete`, { method: "POST", redirect: "manual" });
      expect(inspection.query("SELECT id FROM books ORDER BY id").all()).toEqual([
        { id: first.id },
      ]);
      inspection.close();

      const shelf = openShelf(dbPath);
      expect(shelf.add("Third Book", "Third Author")).toBe(second.id + 1n);
      shelf.close();
    } finally {
      app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
