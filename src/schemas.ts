import { Type, type Static } from "typebox";

const question = Type.String({ minLength: 1, maxLength: 128 });
export const SearchParams = Type.Object({
  query: Type.String({
    minLength: 1, maxLength: 128, pattern: "\\S",
    description: 'Search query, 1–128 Unicode characters, not whitespace-only. Supports site:, -site:, -word, -"phrase", "exact phrase", lang:zh,en, after:YYYY or YYYY-MM-DD, before:YYYY or YYYY-MM-DD and OR.',
  }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  ori_question: Type.Optional(Type.Union([question, Type.Null()], {
    description: "Original user question (1–128 characters); null means omitted.",
  })),
  localization: Type.Optional(Type.String({ description: "IP address used to prioritize localized results (default empty)." })),
  need_content: Type.Optional(Type.Boolean({ default: false, description: "Request page bodies; tool text provides local Markdown file paths, while structured results retain content. Otherwise content is empty." })),
}, { additionalProperties: false });

export const FetchParams = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 8192, description: "HTTP(S) page URL with a host, without username or password. Sent to the web retrieval service." }),
}, { additionalProperties: false });

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const SearchResponse = Type.Object({
  results: Type.Array(Type.Object({
    rerank_score: Type.Number({ minimum: 0, maximum: 3 }),
    title: Type.String(),
    url: Type.String(),
    snippet: Type.String(),
    summary: Type.String(),
    content: Type.String(),
    site_name: nullableString,
    site_icon: nullableString,
    date: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    authority: Type.Integer({ minimum: -1, maximum: 4 }),
  })),
});
export const FetchResponse = Type.Object({ title: Type.String(), content: Type.String() });

export type SearchInput = Static<typeof SearchParams>;
export type FetchInput = Static<typeof FetchParams>;
export type SearchData = Static<typeof SearchResponse>;
export type FetchData = Static<typeof FetchResponse>;
