import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openShelf } from "../src/db";
import { startServer } from "../src/server";

function decodeNumericCharacterReferences(value: string) {
  return value.replace(
    /&#(?:x([\da-f]+)|(\d+));?/gi,
    (_, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(
        hexadecimal ?? decimal!,
        hexadecimal ? 16 : 10,
      );
      if (
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "\ufffd";
      }
      return String.fromCodePoint(codePoint);
    },
  );
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
    app = startServer({ port: 0, dbPath: ":memory:" });
    base = app.server.url.origin;
  });
  afterAll(() => app.close());

  test("renders, creates, toggles, and deletes a book", async () => {
    let response = await fetch(base);
    let body = await response.text();
    expect(body).toContain("<b>0</b> of 0 read");
    const skipLinks: { href: string | null; text: string }[] = [];
    const renderedIdOwners: {
      id: string;
      tagName: string;
      tabindex: string | null;
    }[] = [];
    const parsedBody = new HTMLRewriter()
      .on("a.skip-link", {
        element(element) {
          skipLinks.push({ href: element.getAttribute("href"), text: "" });
        },
        text(text) {
          skipLinks.at(-1)!.text += text.text;
        },
      })
      .on("[id]", {
        element(element) {
          const id = element.getAttribute("id");
          if (id === null) return;
          renderedIdOwners.push({
            id: decodeNumericCharacterReferences(id),
            tagName: element.tagName,
            tabindex: element.getAttribute("tabindex"),
          });
        },
      })
      .transform(new Response(body));
    await parsedBody.text();
    expect(skipLinks).toHaveLength(1);
    expect(skipLinks[0]!.text.trim()).toBe("Skip to books");
    expect(skipLinks[0]!.href?.[0]).toBe("#");
    const targetId = decodeURIComponent(skipLinks[0]!.href!.slice(1));
    const targetOwners = renderedIdOwners.filter(({ id }) => id === targetId);
    expect(targetOwners).toHaveLength(1);
    expect(targetOwners[0]).toMatchObject({
      tagName: "section",
      tabindex: "-1",
    });

    const targetHeadings: string[] = [];
    let currentHeading = -1;
    const parsedHeadings = new HTMLRewriter()
      .on(`[id="${targetId}"] > h2`, {
        element() {
          currentHeading = targetHeadings.push("") - 1;
        },
        text(text) {
          targetHeadings[currentHeading] += text.text;
        },
      })
      .transform(new Response(body));
    await parsedHeadings.text();
    expect(targetHeadings.map((heading) => heading.trim())).toEqual(["Books"]);

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
