import { maxBookFieldLength } from "./book";
import type { Book } from "./db";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
      char
    ]!,
  );

export function page(books: Book[], error = "") {
  const read = books.filter((book) => book.read).length;
  const rows = books
    .map(
      (book) => `<li class="book${book.read ? " is-read" : ""}">
        <form method="post" action="/books/${book.id}/toggle">
          <button class="check" aria-label="Mark ${book.read ? "unread" : "read"}">${book.read ? "✓" : ""}</button>
        </form>
        <div><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span></div>
        <form method="post" action="/books/${book.id}/delete" class="delete-form">
          <button class="delete" aria-label="Delete ${escapeHtml(book.title)}">Delete</button>
        </form>
      </li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shelf</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><main>
  <header><div><h1>Shelf</h1><p>Your personal reading list</p></div><div class="count"><b>${read}</b> of ${books.length} read</div></header>
  <form class="add" method="post" action="/books">
    <label>Title<input name="title" required maxlength="${maxBookFieldLength}" placeholder="The Left Hand of Darkness"></label>
    <label>Author<input name="author" required maxlength="${maxBookFieldLength}" placeholder="Ursula K. Le Guin"></label>
    <button>Add book</button>
  </form>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <section><h2>Books</h2>${rows ? `<ul>${rows}</ul>` : `<div class="empty"><p>Your shelf is empty.</p><span>Add a book to begin.</span></div>`}</section>
</main></body></html>`;
}
