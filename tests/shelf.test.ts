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
