import { Database } from "bun:sqlite";

export type BookId = bigint;

const minimumBookId = -(1n << 63n);
const maximumBookId = (1n << 63n) - 1n;

export function parseBookId(value: string): BookId | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const id = BigInt(value);
  return id >= minimumBookId && id <= maximumBookId ? id : undefined;
}

export type Book = {
  id: BookId;
  title: string;
  author: string;
  read: boolean;
  createdAt: string;
};

export type ExportedBook = Pick<Book, "id" | "title" | "author" | "read">;

type BookRow = Omit<Book, "read" | "createdAt"> & {
  read: bigint;
  created_at: string;
};

type ExportedBookRow = Omit<ExportedBook, "read"> & { read: bigint };

export function openShelf(path = process.env.SHELF_DB ?? "shelf.db") {
  const db = new Database(path, { create: true, safeIntegers: true });
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
  );
  const exportList = db.query<ExportedBookRow, []>(
    "SELECT id, title, author, read FROM books ORDER BY id ASC",
  );
  const insert = db.query("INSERT INTO books (title, author) VALUES (?, ?)");
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
    exportBooks(): ExportedBook[] {
      return exportList.all().map(({ id, title, author, read }) => ({
        id,
        title,
        author,
        read: Boolean(read),
      }));
    },
    add(title: string, author: string): BookId {
      const id = insert.run(title.trim(), author.trim()).lastInsertRowid;
      if (typeof id !== "bigint") throw new TypeError("SQLite did not return an exact book ID");
      return id;
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
