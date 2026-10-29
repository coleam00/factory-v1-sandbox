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
    expect(body).not.toContain("maxlength");

    response = await addBook("Kindred", "Octavia E. Butler");
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
      const response = await addBook(attempt.title, attempt.author);
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain(attempt.message);
      expect(body).toContain("Dune");
      expect(body).toContain("<b>0</b> of 1 read");
    }

    const body = await (await fetch(base)).text();
    expect(body).toContain("Dune");
    expect(body).toContain("<b>0</b> of 1 read");
  });
});
