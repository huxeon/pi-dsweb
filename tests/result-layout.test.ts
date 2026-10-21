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
  assert.deepEqual(details, [{ title, url, snippet, domain: "source.example" }]);
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
  assert(compactText(folded).includes(title));
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
  assert(compactText(searchHost).includes(title));
  assert(compactText(searchHost).includes(url));
  searchHost.setExpanded(true);
  const text = compactText(searchHost);
  assert(text.includes(title));
  assert(text.includes(url));
  assert(text.includes(snippet.replace(/\s/g, "")));
  const fetchHost = new ToolExecutionComponent("web_fetch", "host-fetch-layout", { url: "https://example.org/page" }, {},
    { renderCall: renderFetchCall as NonNullable<ToolDefinition["renderCall"]>, renderResult: renderFetchResult }, ui, process.cwd());
  fetchHost.updateResult({ ...fetched, isError: false });
  assert(compactText(fetchHost).includes(title));
  assert(compactText(fetchHost).includes("https://example.org/page"));
  fetchHost.setExpanded(true);
  assert(compactText(fetchHost).includes(title));
  assert(compactText(fetchHost).includes("Shortpagebody"));
});
