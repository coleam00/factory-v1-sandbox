import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    let body = await response.text();
    expect(body).toContain("<b>0</b> of 0 read");
    const skipLinks = [
      ...body.matchAll(
        /<a class="skip-link" href="#([^"]+)">Skip to books<\/a>/g,
      ),
    ];
    expect(skipLinks).toHaveLength(1);
    const target = `<section id="${skipLinks[0]![1]}" tabindex="-1"><h2>Books</h2>`;
    expect(body.split(target)).toHaveLength(2);

    response = await fetch(`${base}/books`, {
      method: "POST",
      body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);

    body = await (await fetch(base)).text();
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
