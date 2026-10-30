import { bookId, type ShelfDb } from "../src/db";

declare const shelf: ShelfDb;

const checkedId = bookId(1n);
if (checkedId !== null) {
  shelf.toggle(checkedId);
  shelf.remove(checkedId);
}

const uncheckedId = 1n;
// @ts-expect-error Mutation IDs must pass through bookId first.
shelf.toggle(uncheckedId);
// @ts-expect-error Mutation IDs must pass through bookId first.
shelf.remove(uncheckedId);
