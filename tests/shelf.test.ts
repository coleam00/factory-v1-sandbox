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

  test("keeps generated and listed IDs exact above the safe-integer boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "shelf-test-"));
    const dbPath = join(directory, "shelf.db");
    const db = openShelf(dbPath);
    const inspectionDb = new Database(dbPath);
    const adjacentId = "9007199254740992";
    const targetId = "9007199254740993";

    try {
      inspectionDb
        .query("INSERT INTO books (id, title, author) VALUES (?, ?, ?)")
        .run(BigInt(adjacentId), "Adjacent", "Exact ID");

      expect(db.add("Target", "Exact ID")).toBe(targetId);
      expect(db.list().map((book) => book.id)).toEqual([targetId, adjacentId]);
    } finally {
      inspectionDb.close();
      db.close();
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

  for (const action of ["toggle", "delete"] as const) {
    test(`${action} preserves exact numeric IDs and reports missing books`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "shelf-test-"));
      const dbPath = join(directory, "shelf.db");
      const isolatedApp = startServer({ port: 0, dbPath });
      const inspectionDb = new Database(dbPath);
      const adjacentId = "9007199254740992";
      const targetId = "9007199254740993";
      const missingId = "9007199254740994";
      const insert = inspectionDb.query(
        "INSERT INTO books (id, title, author) VALUES (?, ?, ?)",
      );
      insert.run(1, "Control", "Still Here");
      insert.run(BigInt(adjacentId), "Adjacent", "Must Not Change");
      insert.run(BigInt(targetId), "Target", "Exact ID");
      const books = () =>
        inspectionDb
          .query<
            { id: string; title: string; author: string; read: number; created_at: string },
            []
          >(
            "SELECT CAST(id AS TEXT) AS id, title, author, read, created_at FROM books ORDER BY id",
          )
          .all();

      try {
        const before = books();
        const missing = await fetch(`${isolatedApp.server.url}books/${missingId}/${action}`, {
          method: "POST",
          redirect: "manual",
        });
        expect(missing.status).toBe(404);
        expect(books()).toEqual(before);

        const body = await (await fetch(isolatedApp.server.url)).text();
        const targetRow = body
          .match(/<li class="book[^>]*>[\s\S]*?<\/li>/g)
          ?.find((row) => row.includes("<strong>Target</strong>"));
        const targetAction = targetRow?.match(
          new RegExp(`action="([^"]+/${action})"`),
        )?.[1];
        expect(targetAction).toBe(`/books/${targetId}/${action}`);
        if (!targetAction) throw new Error("Target form action is missing");

        const existing = await fetch(new URL(targetAction, isolatedApp.server.url), {
          method: "POST",
          redirect: "manual",
        });
        expect(existing.status).toBe(303);

        if (action === "toggle") {
          expect(books()).toEqual([
            before[0],
            before[1],
            { ...before[2], read: 1 },
          ]);
        } else {
          expect(books()).toEqual([before[0], before[1]]);
        }
      } finally {
        inspectionDb.close();
        isolatedApp.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
