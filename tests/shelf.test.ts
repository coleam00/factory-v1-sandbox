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
});

describe("JSON export", () => {
  let app: ReturnType<typeof startServer>;
  let base: string;
  let directory: string;
  let dbPath: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "shelf-export-"));
    dbPath = join(directory, "shelf.db");
    app = startServer({ port: 0, dbPath });
    base = app.server.url.origin;
  });

  afterAll(() => {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("downloads every book as stable, non-mutating JSON", async () => {
    const empty = await fetch(`${base}/books/export.json`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toStartWith("application/json");
    expect(empty.headers.get("content-disposition")).toBe('attachment; filename="shelf.json"');
    expect(await empty.text()).toBe("[]");

    const first = { title: 'A <Shelf> & "Stories"', author: "Anne O'Writer" };
    const second = { title: "Second Book", author: "Another Author" };
    for (const book of [first, second]) {
      const response = await fetch(`${base}/books`, {
        method: "POST",
        body: new URLSearchParams(book),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
    }
    await fetch(`${base}/books/1/toggle`, { method: "POST", redirect: "manual" });

    const pageBody = await (await fetch(base)).text();
    expect(pageBody.indexOf(second.title)).toBeLessThan(pageBody.indexOf("A &lt;Shelf&gt;"));

    const inspection = new Database(dbPath, { readonly: true });
    const schemaBefore = inspection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    const booksBefore = inspection.query("SELECT * FROM books ORDER BY id").all();

    const response = await fetch(`${base}/books/export.json?filter=unread`);
    const raw = await response.text();
    expect(raw).toContain('<Shelf> & \\"Stories\\"');
    const exported = JSON.parse(raw);
    expect(exported).toEqual([
      { id: 1, title: first.title, author: first.author, read: true },
      { id: 2, title: second.title, author: second.author, read: false },
    ]);
    expect(Object.keys(exported[0])).toEqual(["id", "title", "author", "read"]);
    expect(Object.keys(exported[1])).toEqual(["id", "title", "author", "read"]);

    expect(
      inspection.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all(),
    ).toEqual(schemaBefore);
    expect(inspection.query("SELECT * FROM books ORDER BY id").all()).toEqual(booksBefore);
    inspection.close();
  });
});
