import { Database } from "bun:sqlite";

declare const bookIdBrand: unique symbol;

export type BookId = bigint & { readonly [bookIdBrand]: true };

const sqliteIntegerMin = -9223372036854775808n;
const sqliteIntegerMax = 9223372036854775807n;

export const bookId = (value: bigint): BookId | null =>
  value >= sqliteIntegerMin && value <= sqliteIntegerMax ? (value as BookId) : null;

export type Book = {
  id: BookId;
  title: string;
  author: string;
  read: boolean;
  createdAt: string;
};

type BookRow = Omit<Book, "read" | "createdAt"> & {
  read: bigint;
  created_at: string;
};

export function openShelf(path = process.env.SHELF_DB ?? "shelf.db") {
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const list = db.query<BookRow, []>(
    "SELECT id, title, author, read, created_at FROM books ORDER BY id DESC",
  ).safeIntegers(true);
  const insert = db
    .query<{ id: bigint }, [string, string]>(
      "INSERT INTO books (title, author) VALUES (?, ?) RETURNING id",
    )
    .safeIntegers(true);
  const toggle = db.query(
    "UPDATE books SET read = CASE read WHEN 0 THEN 1 ELSE 0 END WHERE id = ?",
  );
  const remove = db.query("DELETE FROM books WHERE id = ?");

  return {
    list(): Book[] {
      return list.all().map(({ created_at, read, ...book }) => ({
        ...book,
        read: Boolean(read),
        createdAt: created_at,
      }));
    },
    add(title: string, author: string) {
      return insert.get(title.trim(), author.trim())!.id;
    },
    toggle(id: BookId) {
      return toggle.run(id).changes === 1;
    },
    remove(id: BookId) {
      return remove.run(id).changes === 1;
    },
    close() {
      db.close();
    },
  };
}

export type ShelfDb = ReturnType<typeof openShelf>;
