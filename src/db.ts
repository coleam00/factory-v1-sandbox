import { Database } from "bun:sqlite";

export type Book = {
  id: number;
  title: string;
  author: string;
  read: boolean;
  createdAt: string;
};

type BookRow = Omit<Book, "read" | "createdAt"> & {
  read: number;
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
    add(title: string, author: string) {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) throw new Error("Title is required.");
      return Number(insert.run(normalizedTitle, author.trim()).lastInsertRowid);
    },
    toggle(id: number) {
      return toggle.run(id).changes === 1;
    },
    remove(id: number) {
      return remove.run(id).changes === 1;
    },
    close() {
      db.close();
    },
  };
}

export type ShelfDb = ReturnType<typeof openShelf>;
