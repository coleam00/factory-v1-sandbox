# Shelf

Shelf is a small, server-rendered personal reading list. Add books, mark them read or unread, remove them, and filter or order the shelf; the data is stored locally in SQLite.

## Run

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run dev
```

Open <http://localhost:3000>. Use `PORT` to choose another port and `SHELF_DB` to choose another database path (the default is `shelf.db`). For a non-watching process, run `bun start`.

## Test

```sh
bun test
bun run typecheck
```
