import type { BookId } from "./db";

export const mutationActions = {
  toggle: "toggle",
  delete: "delete",
} as const;

export type MutationAction = (typeof mutationActions)[keyof typeof mutationActions];
export type MutationHandler = (id: BookId) => boolean;

const mutationActionValues = new Set<string>(Object.values(mutationActions));

export const isMutationAction = (value: string): value is MutationAction =>
  mutationActionValues.has(value);

export const mutationPath = (id: BookId, action: MutationAction) =>
  `/books/${id}/${action}`;
