import { Database } from "bun:sqlite";

const sqliteIntegerMax = "9223372036854775807";
declare const bookIdBrand: unique symbol;

export type BookId = string & { readonly [bookIdBrand]: true };

export function parseBookId(value: string): BookId | null {
  if (!/^\d+$/.test(value)) return null;

  const canonical = value.replace(/^0+/, "");
  if (
    canonical.length === 0 ||
    canonical.length > sqliteIntegerMax.length ||
    (canonical.length === sqliteIntegerMax.length && canonical > sqliteIntegerMax)
  ) {
    return null;
  }

  return canonical as BookId;
}

export type Book = {
  id: BookId;
  title: string;
  author: string;
  read: boolean;
  createdAt: string;
};

type BookRow = Omit<Book, "id" | "read" | "createdAt"> & {
  id: string;
  read: number;
  created_at: string;
};

const bookIdFromDatabase = (value: string) => {
  const id = parseBookId(value);
  if (id === null) throw new Error("Database returned an invalid book ID");
  return id;
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
    "SELECT CAST(id AS TEXT) AS id, title, author, read, created_at FROM books ORDER BY books.id DESC",
  );
  const insert = db.query<{ id: string }, [string, string]>(
    "INSERT INTO books (title, author) VALUES (?, ?) RETURNING CAST(id AS TEXT) AS id",
  );
  const toggle = db.query(
    "UPDATE books SET read = CASE read WHEN 0 THEN 1 ELSE 0 END WHERE id = ?",
  );
  const remove = db.query("DELETE FROM books WHERE id = ?");

  return {
    list(): Book[] {
      return list.all().map(({ id, created_at, read, ...book }) => ({
        ...book,
        id: bookIdFromDatabase(id),
        read: Boolean(read),
        createdAt: created_at,
      }));
    },
    add(title: string, author: string) {
      return bookIdFromDatabase(insert.get(title.trim(), author.trim())!.id);
    },
    toggle(id: BookId) {
      const exactId = parseBookId(id);
      return exactId !== null && toggle.run(exactId).changes === 1;
    },
    remove(id: BookId) {
      const exactId = parseBookId(id);
      return exactId !== null && remove.run(exactId).changes === 1;
    },
    close() {
      db.close();
    },
  };
}

export type ShelfDb = ReturnType<typeof openShelf>;
