import type { Book } from "./db";

const newestIdFirst = (left: Book, right: Book) =>
  left.id === right.id ? 0 : left.id < right.id ? 1 : -1;

export const viewFields = {
  filter: {
    defaultValue: "all",
    options: {
      all: { label: "All books", includes: (_book: Book) => true },
      unread: { label: "Unread only", includes: (book: Book) => !book.read },
    },
  },
  order: {
    defaultValue: "added",
    options: {
      added: {
        label: "Recently added",
        compare: (left: Book, right: Book) =>
          right.createdAt.localeCompare(left.createdAt) || newestIdFirst(left, right),
      },
      title: {
        label: "Title A-Z",
        compare: (left: Book, right: Book) => {
          const byTitle = left.title.localeCompare(right.title, undefined, {
            sensitivity: "base",
          });
          return byTitle || newestIdFirst(left, right);
        },
      },
    },
  },
} as const;

export type ViewState = {
  [Field in keyof typeof viewFields]: Extract<
    keyof (typeof viewFields)[Field]["options"],
    string
  >;
};

const hasOption = <Options extends object>(
  options: Options,
  value: string | null,
): value is Extract<keyof Options, string> => value !== null && Object.hasOwn(options, value);

export const parseView = (url: URL): ViewState => {
  const filter = url.searchParams.get("filter");
  const order = url.searchParams.get("order");

  return {
    filter: hasOption(viewFields.filter.options, filter)
      ? filter
      : viewFields.filter.defaultValue,
    order: hasOption(viewFields.order.options, order)
      ? order
      : viewFields.order.defaultValue,
  };
};

const query = (view: ViewState) => new URLSearchParams(view).toString();

export const viewQuery = (view: ViewState) => `?${query(view).replaceAll("&", "&amp;")}`;

export const viewLocation = (url: URL, view: ViewState) => {
  const hasViewState = Object.keys(viewFields).some((field) => url.searchParams.has(field));
  return hasViewState ? `/?${query(view)}` : "/";
};

export const applyView = (books: Book[], view: ViewState) =>
  books
    .filter(viewFields.filter.options[view.filter].includes)
    .sort(viewFields.order.options[view.order].compare);
