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

export function assertMutationHandlers(
  handlers: Record<string, unknown>,
): asserts handlers is Record<MutationAction, MutationHandler> {
  const handlerKeys = Reflect.ownKeys(handlers);
  const hasExactKeys =
    handlerKeys.length === mutationActionValues.size &&
    handlerKeys.every(
      (key) => typeof key === "string" && mutationActionValues.has(key),
    );
  const hasCallableHandlers = Object.values(mutationActions).every(
    (action) => typeof handlers[action] === "function",
  );

  if (!hasExactKeys || !hasCallableHandlers) {
    throw new TypeError("Mutation handlers must exactly match mutation actions");
  }
}
