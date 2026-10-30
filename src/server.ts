import { join } from "node:path";
import { bookFields, maxBookFieldLength } from "./book-fields";
import { bookId, openShelf } from "./db";
import { parseView, viewLocation } from "./view-state";
import { page } from "./views";

const publicDir = join(import.meta.dir, "..", "public");
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (location: string) => Response.redirect(location, 303);
const parseRevision = (value: string | undefined) =>
  value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;

type BookFormResult =
  | { book: { title: string; author: string } }
  | { error: string };

const readBookField = (
  form: FormData,
  field: (typeof bookFields)[keyof typeof bookFields],
) => {
  const entries = form.getAll(field.name);
  if (entries.length === 0) return { value: "" } as const;
  if (entries.length !== 1 || typeof entries[0] !== "string") {
    return { error: `${field.label} must be submitted exactly once as text.` } as const;
  }
  return { value: entries[0].trim() } as const;
};

const decodeBookForm = (form: FormData): BookFormResult => {
  const title = readBookField(form, bookFields.title);
  if ("error" in title) return title;
  const author = readBookField(form, bookFields.author);
  if ("error" in author) return author;

  if (!title.value || !author.value) {
    return { error: "Title and author are required." };
  }
  if (title.value.length > maxBookFieldLength) {
    return { error: `Title must be ${maxBookFieldLength} characters or fewer.` };
  }
  if (author.value.length > maxBookFieldLength) {
    return { error: `Author must be ${maxBookFieldLength} characters or fewer.` };
  }

  return { book: { title: title.value, author: author.value } };
};

export function startServer(options: { port?: number; dbPath?: string } = {}) {
  const revision = parseRevision(process.env.APP_REVISION);
  const shelf = openShelf(options.dbPath);
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    async fetch(request) {
      const url = new URL(request.url);
      const view = parseView(url);

      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", revision });
      }
      if (request.method === "GET" && url.pathname === "/") return html(page(shelf.list(), view));
      if (request.method === "GET" && url.pathname === "/books/export.json") {
        return new Response(
          JSON.stringify(shelf.exportBooks(), (_key, value) =>
            typeof value === "bigint" ? JSON.rawJSON(value.toString()) : value,
          ),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": 'attachment; filename="shelf.json"',
            },
          },
        );
      }
      if (request.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/style.css")) {
        return new Response(Bun.file(join(publicDir, url.pathname.slice(1))));
      }
      if (request.method === "POST" && url.pathname === "/books") {
        const form = await request.formData();
        const result = decodeBookForm(form);
        if ("error" in result) {
          return html(page(shelf.list(), view, result.error), 400);
        }
        shelf.add(result.book.title, result.book.author);
        return redirect(viewLocation(url, view));
      }

      const match = url.pathname.match(/^\/books\/(-?\d+)\/(toggle|delete)$/);
      if (request.method === "POST" && match) {
        const id = bookId(BigInt(match[1]));
        if (id === null) {
          return html(page(shelf.list(), view, "Book not found."), 404);
        }
        const changed = match[2] === "toggle" ? shelf.toggle(id) : shelf.remove(id);
        if (!changed) return html(page(shelf.list(), view, "Book not found."), 404);
        return redirect(viewLocation(url, view));
      }
      return new Response("Not found", { status: 404 });
    },
  });

  return {
    server,
    close() {
      server.stop(true);
      shelf.close();
    },
  };
}

if (import.meta.main) {
  const { server } = startServer();
  console.log(`Shelf is running at ${server.url}`);
}
