import { join } from "node:path";
import { openShelf } from "./db";
import { page } from "./views";

const maxBookFieldLength = 200;
const publicDir = join(import.meta.dir, "..", "public");
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = () => Response.redirect("/", 303);

export function startServer(options: { port?: number; dbPath?: string } = {}) {
  const shelf = openShelf(options.dbPath);
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") return html(page(shelf.list()));
      if (request.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/style.css")) {
        return new Response(Bun.file(join(publicDir, url.pathname.slice(1))));
      }
      if (request.method === "POST" && url.pathname === "/books") {
        const form = await request.formData();
        const title = String(form.get("title") ?? "").trim();
        const author = String(form.get("author") ?? "").trim();
        if (!title || !author) return html(page(shelf.list(), "Title and author are required."), 400);
        if (title.length > maxBookFieldLength) {
          return html(
            page(shelf.list(), `Title must be ${maxBookFieldLength} characters or fewer.`),
            400,
          );
        }
        if (author.length > maxBookFieldLength) {
          return html(
            page(shelf.list(), `Author must be ${maxBookFieldLength} characters or fewer.`),
            400,
          );
        }
        shelf.add(title, author);
        return redirect();
      }

      const match = url.pathname.match(/^\/books\/(\d+)\/(toggle|delete)$/);
      if (request.method === "POST" && match) {
        const id = Number(match[1]);
        match[2] === "toggle" ? shelf.toggle(id) : shelf.remove(id);
        return redirect();
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
