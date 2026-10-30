import type { Book } from "./db";
import {
  applyView,
  viewFields,
  viewQuery,
  type ViewState,
} from "./view-state";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
      char
    ]!,
  );

const optionTags = (
  options: Record<string, { readonly label: string }>,
  selected: string,
) =>
  Object.entries(options)
    .map(
      ([value, option]) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");

export function page(
  books: Book[],
  view: ViewState,
  error = "",
) {
  const read = books.filter((book) => book.read).length;
  const visibleBooks = applyView(books, view);
  const query = viewQuery(view);
  const rows = visibleBooks
    .map(
      (book) => `<li class="book${book.read ? " is-read" : ""}">
        <form method="post" action="/books/${book.id}/toggle${query}">
          <button class="check" aria-label="Mark ${escapeHtml(book.title)} as ${book.read ? "unread" : "read"} (book ${book.id})">${book.read ? "✓" : ""}</button>
        </form>
        <div><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span></div>
        <form method="post" action="/books/${book.id}/delete${query}" class="delete-form">
          <button class="delete" aria-label="Delete ${escapeHtml(book.title)}">Delete</button>
        </form>
      </li>`,
    )
    .join("");
  const empty =
    books.length === 0
      ? `<div class="empty"><p>Your shelf is empty.</p><span>Add a book to begin.</span></div>`
      : `<div class="empty"><p>No unread books.</p><span>Everything on your shelf is marked read.</span></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shelf</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><main>
  <header><div><h1>Shelf</h1><p>Your personal reading list</p></div><div class="count"><b>${read}</b> of ${books.length} read</div></header>
  <form class="add" method="post" action="/books${query}">
    <label>Title<input name="title" required maxlength="200" placeholder="The Left Hand of Darkness"></label>
    <label>Author<input name="author" required maxlength="200" placeholder="Ursula K. Le Guin"></label>
    <button>Add book</button>
  </form>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <section><div class="shelf-heading"><h2>Books</h2>
    <form class="view-controls" method="get" action="/">
      <label>Show<select name="filter">
        ${optionTags(viewFields.filter.options, view.filter)}
      </select></label>
      <label>Order<select name="order">
        ${optionTags(viewFields.order.options, view.order)}
      </select></label>
      <button>Apply</button>
    </form>
  </div>${rows ? `<ul>${rows}</ul>` : empty}</section>
</main></body></html>`;
}
