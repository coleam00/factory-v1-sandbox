import { join } from "node:path";
import { openShelf } from "./db";
import { parseView, viewLocation } from "./view-state";
import { page } from "./views";

const publicDir = join(import.meta.dir, "..", "public");
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (location: string) => Response.redirect(location, 303);
const parseRevision = (value: string | undefined) =>
  value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;

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
      if (request.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/style.css")) {
        return new Response(Bun.file(join(publicDir, url.pathname.slice(1))));
      }
      if (request.method === "POST" && url.pathname === "/books") {
        const form = await request.formData();
        const title = String(form.get("title") ?? "").trim();
        const author = String(form.get("author") ?? "").trim();
        if (!title || !author) {
          return html(page(shelf.list(), view, "Title and author are required."), 400);
        }
        shelf.add(title.slice(0, 200), author.slice(0, 200));
        return redirect(viewLocation(url, view));
      }

      const match = url.pathname.match(/^\/books\/(\d+)\/(toggle|delete)$/);
      if (request.method === "POST" && match) {
        const id = match[1];
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
