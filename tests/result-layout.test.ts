import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { buildSearchItems, safeText } from "../src/presentation.ts";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "../src/renderers.ts";
import { makeFetchResult, makeSearchResult } from "./helpers.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const context = (overrides: Partial<Context> = {}): Context => ({
  args: {}, state: {}, toolCallId: "result-layout", invalidate() {}, lastComponent: undefined,
  cwd: ".", executionStarted: true, argsComplete: true, isPartial: false,
  expanded: false, showImages: false, isError: false, durationMs: 1200, outputPad: 0, ...overrides,
});
const expandedOptions = { expanded: true, isPartial: false };
const foldedOptions = { expanded: false, isPartial: false };
const rows = (component: Component, width = 80) => component.render(width).map(line => stripTerminalSequences(line).trimEnd());
const compactText = (component: Component, width = 80) => rows(component, width).join("").replace(/\s/g, "");
const title = "中文标题".repeat(80) + "TITLE_END";
const url = "https://source.example/" + "path/".repeat(150) + "?q=exact%20phrase#URL_END";
const snippet = "这是官方返回的中文短摘要。".repeat(20) + "\n\nSecond paragraph. SNIPPET_END";
const item = {
  title, url, snippet, summary: "MODEL LONG SUMMARY", content: "",
  rerank_score: 2, authority: 3, site_name: null, site_icon: null, date: null,
};

test("Search details retain complete titles/URLs/snippets without duplicating summaries or bodies", () => {
  const data = { results: [item] };
  const original = structuredClone(data);
  const details = buildSearchItems(data);
  assert.deepEqual(details, [{ title, url, snippet }]);
  assert(!JSON.stringify(details).includes("MODEL LONG SUMMARY"));
  assert.deepEqual(data, original);
});

test("Search expansion shows complete multilingual fields at any width", async () => {
  const data = { results: [item] };
  const result = await makeSearchResult(data);
  const before = structuredClone(result);
  const folded = renderSearchResult(result, foldedOptions, theme, context());
  const expanded = renderSearchResult(result, expandedOptions, theme, context({ lastComponent: folded }));
  assert.equal(expanded, folded);
  for (const width of [8, 24, 80, 120]) {
    const text = compactText(expanded, width);
    assert(text.includes(title));
    assert(text.includes(url));
    assert(text.includes(snippet.replace(/\s/g, "")));
    assert(!text.includes("toexpand"));
    assert(expanded.render(width).every(line => visibleWidth(line) <= width));
  }
  assert(!compactText(expanded).includes("MODEL LONG SUMMARY"));
  assert.equal(result.structuredContent, data);
  assert.deepEqual(result, before);
});

test("expanded result text wraps and refreshes on new data", async () => {
  const result = await makeSearchResult({ results: [item] });
  const component = renderSearchResult(result, expandedOptions, theme, context());
  rows(component);
  const reused = renderSearchResult(result, expandedOptions, theme, context({ lastComponent: component }));
  rows(reused, 40);
  assert.equal(reused, component);
  reused.invalidate();
  assert(compactText(reused).includes("SNIPPET_END"));
  const nextResult = await makeSearchResult({ results: [{ ...item, title: "New title", url: "https://other.example/new", snippet: "New snippet" }] });
  const next = renderSearchResult(nextResult, expandedOptions, theme, context({ lastComponent: reused }));
  const text = compactText(next);
  assert.equal(next, component);
  assert(text.includes("Newtitle"));
  assert(text.includes("https://other.example/new"));
  assert(text.includes("Newsnippet"));
  assert(!text.includes("TITLE_END"));
});

test("Fetch retains its full title and expands the complete model-visible body", async () => {
  const page = { title, content: Array.from({ length: 200 }, (_, i) => `Body ${i}`).join("\n") + "\nMODEL_BODY_END" };
  const result = await makeFetchResult(page);
  assert.equal(result.details.title, title);
  const folded = renderFetchResult(result, foldedOptions, theme, context());
  assert(compactText(folded).includes(title.slice(0, 20)));
  assert(!compactText(folded).includes("TITLE_END"));
  assert(!compactText(folded).includes("MODEL_BODY_END"));
  assert(compactText(folded).includes("morelines"));
  const expanded = renderFetchResult(result, expandedOptions, theme, context({ lastComponent: folded }));
  for (const width of [8, 24, 80, 120]) {
    assert(compactText(expanded, width).includes(title));
    assert(expanded.render(width).every(line => visibleWidth(line) <= width));
  }
  const displayed = rows(expanded).join("\n");
  assert(displayed.includes("MODEL_BODY_END"));
  assert(result.content[0].text.includes("MODEL_BODY_END"));
  assert.equal(result.structuredContent, page);
});

test("full result fields remain display-safe and do not mutate model or codemode text", async () => {
  const unsafe = "\u001b[2J\u001b]0;hostile\u0007\u202e";
  const data = { results: [{ ...item, title: unsafe + title, url: "https://source.example/" + unsafe + "x".repeat(400) + "SAFE_URL_END", snippet: unsafe + snippet }] };
  const result = await makeSearchResult(data);
  assert.equal(result.structuredContent, data);
  const component = renderSearchResult(result, expandedOptions, theme, context());
  const rendered = component.render(80).join("\n");
  assert(!rendered.includes("\u001b[2J"));
  assert(!rendered.includes("\u001b]0;"));
  assert(!rendered.includes("\u202e"));
  assert(compactText(component).includes("SAFE_URL_END"));
  assert(compactText(component).includes("SNIPPET_END"));
  const page = { title: unsafe + title, content: "body" };
  const fetched = await makeFetchResult(page);
  assert(!fetched.content[0].text.includes("\u001b[2J"));
  assert(!fetched.content[0].text.includes("\u001b]0;"));
  assert(!fetched.content[0].text.includes("\u202e"));
  assert.equal(fetched.structuredContent, page);
  assert.equal(fetched.details.title, safeText(page.title));
});

test("persisted Search fields are sanitized at render time without mutating results", () => {
  const unsafe = "\u001b[31m\u001b[2J\u001b]0;hostile\u0007\u202e";
  const result = {
    content: [{ type: "text" as const, text: "MODEL TEXT" }],
    structuredContent: { raw: unsafe },
    details: [{ title: unsafe + "Safe title\nnext", url: "https://source.example/" + unsafe + "path", snippet: unsafe + "Safe snippet" }],
  };
  const original = structuredClone(result);
  for (const expanded of [false, true]) {
    const component = renderSearchResult(result, { expanded, isPartial: false }, theme, context());
    for (const width of [24, 80]) {
      const rendered = component.render(width).join("\n");
      for (const sequence of ["\u001b[31m", "\u001b[2J", "\u001b]0;", "\u202e"]) assert(!rendered.includes(sequence));
    }
    const text = rows(component).join("\n");
    assert(text.includes("1. Safe title next"));
    assert(text.includes("https://source.example/path"));
    assert(text.includes("Safe snippet"));
    assert(!text.includes("MODEL TEXT"));
  }
  assert.deepEqual(result, original);
});

test("very narrow expanded result views never overflow their assigned width", async () => {
  const search = await makeSearchResult({ results: [{ ...item, title: "中😀尾", snippet: "😀中" }] });
  const fetched = await makeFetchResult({ title: "中😀尾", content: "body" });
  const components = [renderSearchResult(search, expandedOptions, theme, context()), renderFetchResult(fetched, expandedOptions, theme, context())];
  for (const component of components) {
    assert.deepEqual(component.render(0), []);
    for (const width of [1, 2, 3]) assert(component.render(width).every(line => visibleWidth(line) <= width));
  }
});

test("Pi host expansion exposes complete Search result fields and Fetch titles from details", async () => {
  const search = await makeSearchResult({ results: [item] });
  const fetched = await makeFetchResult({ title, content: "Short page body" });
  const ui = { requestRender() {} } as unknown as TUI;
  const searchHost = new ToolExecutionComponent("web_search", "host-search-layout", { query: "q" }, {},
    { renderCall: renderSearchCall as NonNullable<ToolDefinition["renderCall"]>, renderResult: renderSearchResult }, ui, process.cwd());
  searchHost.updateResult({ ...search, isError: false });
  assert(compactText(searchHost).includes(title.slice(0, 20)));
  assert(!compactText(searchHost).includes("TITLE_END"));
  searchHost.setExpanded(true);
  const text = compactText(searchHost);
  assert(text.includes(title));
  assert(text.includes(url));
  assert(text.includes(snippet.replace(/\s/g, "")));
  const fetchHost = new ToolExecutionComponent("web_fetch", "host-fetch-layout", { url: "https://example.org/page" }, {},
    { renderCall: renderFetchCall as NonNullable<ToolDefinition["renderCall"]>, renderResult: renderFetchResult }, ui, process.cwd());
  fetchHost.updateResult({ ...fetched, isError: false });
  assert(compactText(fetchHost).includes(title.slice(0, 20)));
  assert(!compactText(fetchHost).includes("TITLE_END"));
  assert(compactText(fetchHost).includes("https://example.org/page"));
  fetchHost.setExpanded(true);
  assert(compactText(fetchHost).includes(title));
  assert(compactText(fetchHost).includes("Shortpagebody"));
});

test("success and error previews share five visual rows without accumulating cached footers", async () => {
  const body = "中😀 words ".repeat(300);
  const result = await makeFetchResult({ title: "", content: body });
  const success = renderFetchResult(result, foldedOptions, theme, context());
  const error = renderFetchResult({ content: [{ type: "text", text: body }], details: undefined },
    foldedOptions, theme, context({ isError: true }));
  for (const width of [1, 8, 24, 80, 32, 80]) {
    const successRows = rows(success, width);
    const errorRows = rows(error, width);
    assert.deepEqual(successRows.slice(1, 6), errorRows.slice(0, 5));
    assert.deepEqual(successRows.slice(6), errorRows.slice(5));
    assert(successRows.slice(6).join("").replace(/\s/g, "").includes("morelines"));
    assert.deepEqual(rows(success, width), successRows);
    assert.deepEqual(rows(error, width), errorRows);
    assert(success.render(width).every(line => visibleWidth(line) <= width));
    assert(error.render(width).every(line => visibleWidth(line) <= width));
  }
});

test("reused result layout clears warnings and content across success, error and partial updates", async () => {
  const result = await makeFetchResult({ title: "Long page", content: "body\n".repeat(2100) });
  const component = renderFetchResult(result, foldedOptions, theme, context());
  const initial = rows(component);
  assert(initial.join("\n").includes("Full output:"));
  component.invalidate();
  assert.deepEqual(rows(component), initial);
  assert.deepEqual(rows(component), initial);

  const failed = renderFetchResult({ content: [{ type: "text", text: "Request failed" }], details: undefined },
    foldedOptions, theme, context({ lastComponent: component, isError: true }));
  assert.equal(failed, component);
  assert.deepEqual(rows(failed), ["Request failed", "", "Took 1.2s"]);

  const pending = renderFetchResult({ content: [], details: undefined },
    { expanded: false, isPartial: true }, theme, context({ lastComponent: component, executionStarted: false }));
  assert.equal(pending, component);
  assert.deepEqual(rows(pending), []);

  const next = await makeFetchResult({ title: "", content: "New body" });
  const completed = renderFetchResult(next, foldedOptions, theme, context({ lastComponent: component }));
  assert.equal(completed, component);
  assert.deepEqual(rows(completed), ["", "New body", "", "Took 1.2s"]);
});
