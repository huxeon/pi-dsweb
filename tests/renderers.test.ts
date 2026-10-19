import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderSearchCall, renderSearchResult, renderFetchCall, renderFetchResult } from "../src/renderers.ts";
import { buildSearchItems, safeText } from "../src/presentation.ts";
import { formatFetch, formatSearch } from "../src/output.ts";
import { makeFetchResult, makeSearchResult } from "./helpers.ts";
import type { SearchData } from "../src/schemas.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
function context(overrides: Partial<Context> = {}): Context {
  return { args: {}, state: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined,
    cwd: ".", executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: false, isError: false, durationMs: 1200, outputPad: 0, ...overrides };
}
const text = (component: Component, width = 100) => component.render(width).map(stripTerminalSequences).join("\n");
const data: SearchData = { results: Array.from({ length: 5 }, (_, index) => ({
  title: `Article ${index + 1}`, url: `https://example.com/${index}`, rerank_score: 2,
  snippet: "Short summary", summary: `Long summary ${index + 1}`, content: "Body",
  site_name: null, site_icon: null, date: null, authority: 3,
})) };

test("call renderers use human labels and compact parameters", () => {
  const search = text(renderSearchCall({ query: "中文搜索 😀", count: 3, need_content: true }, theme, context({ isPartial: true })));
  assert(search.includes("WebSearch"));
  assert(search.includes("中文搜索 😀"));
  assert(search.includes("count=3"));
  assert(search.includes("Searching..."));
  const fetch = text(renderFetchCall({ url: "https://example.com/article" }, theme, context({ isPartial: true })));
  assert(fetch.includes("WebFetch"));
  assert(fetch.includes("https://example.com/article"));
  assert(fetch.includes("Fetching..."));
});

test("incomplete arguments are safe and calls fit narrow terminal widths", () => {
  for (const component of [renderSearchCall({}, theme, context()), renderFetchCall({}, theme, context()), renderSearchCall({ query: "中😀".repeat(200) }, theme, context())]) {
    for (const width of [1, 8, 24, 80]) {
      assert(component.render(width).every(line => visibleWidth(line) <= width));
    }
    assert.deepEqual(component.render(0), []);
  }
});

test("collapsed search shows total and only the first three titles/domains", async () => {
  const result = await makeSearchResult(data);
  const output = text(renderSearchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(output.includes("5 results"));
  assert(output.includes("Article 3"));
  assert(output.includes("example.com"));
  assert(!output.includes("Article 4"));
  assert(!output.includes("Long summary"));
  assert(output.includes("1.2s"));
});

test("empty search is a successful empty state, not a failure", async () => {
  const result = await makeSearchResult({ results: [] });
  const output = text(renderSearchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(output.includes("No matching web results"));
  assert(!output.includes("failed"));
});

test("fetch keeps its title plain when folded and bold when expanded", async () => {
  const result = await makeFetchResult({ title: "Page title", content: "Page body" });
  const styledTheme = { ...theme, bold: (value: string) => "\x1b[1m" + value + "\x1b[22m" } as Theme;
  const folded = renderFetchResult(result, { expanded: false, isPartial: false }, styledTheme, context());
  const collapsedRows = folded.render(100);
  assert.equal(collapsedRows[1], "Page title");
  assert(collapsedRows[0].includes("1.2s"));
  assert(!collapsedRows.includes(""));
  const expanded = renderFetchResult(result, { expanded: true, isPartial: false }, styledTheme, context({ lastComponent: folded }));
  assert.equal(expanded, folded);
  const expandedRows = expanded.render(100);
  assert.equal(expandedRows[1], "");
  assert.equal(expandedRows[2], "\x1b[1mPage title\x1b[22m");
  assert.equal(expandedRows[3], "");
  assert(expandedRows.map(stripTerminalSequences).join("\n").includes("Page body"));
});

test("collapsed fetch shows title/UTF-8 size/duration, without domain or body", async () => {
  const page = { title: "A page", content: "Private body 中😀" };
  const result = await makeFetchResult(page);
  const output = text(renderFetchResult(result, { expanded: false, isPartial: false }, theme, context({ args: { url: "https://example.com" } })));
  assert(output.includes("A page"));
  assert(output.includes(" B"));
  assert(output.includes("1.2s"));
  assert(!output.includes("example.com"));
  assert(!output.includes("Private body"));
});

test("expanded results show source URLs and summaries/Markdown", async () => {
  const result = await makeSearchResult(data);
  const component = renderSearchResult(result, { expanded: true, isPartial: false }, theme, context());
  const output = text(component);
  assert(output.includes("https://example.com/0"));
  assert(output.includes("Short summary"));
  assert(!output.includes("Long summary 1"));
  for (const width of [1, 8, 24, 80]) assert(component.render(width).every(line => visibleWidth(line) <= width));
  component.invalidate();
  assert.equal(text(component), output);
});

test("partial and failed results are explicit even with no details", () => {
  const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "HTTP 429: wait before retrying" }], details: undefined };
  for (const [renderer, waiting] of [[renderSearchResult, "Searching..."], [renderFetchResult, "Fetching..."]] as const) {
    assert(text(renderer(result, { expanded: false, isPartial: true }, theme, context())).includes(waiting));
    const output = text(renderer(result, { expanded: false, isPartial: false }, theme, context({ isError: true })));
    assert(output.includes("HTTP 429"));
    assert(!output.includes("completed"));
  }
});

test("fetch does not fall back to model text for obsolete details", () => {
  const result = { content: [{ type: "text" as const, text: "Legacy response text" }], details: { truncated: false } };
  const output = text(renderFetchResult(result, { expanded: true, isPartial: false }, theme, context()));
  assert(output.includes("Page preview unavailable"));
  assert(!output.includes("Legacy response text"));
});

test("expanded fetch limits its body to 40 rendered lines and shows both omission states", async () => {
  const page = { title: "Large page", content: Array.from({ length: 2100 }, (_, i) => `Line ${i}`).join("\n") };
  const result = await makeFetchResult(page);
  assert(result.details.truncated);
  const collapsed = text(renderFetchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(collapsed.includes("Content truncated"));
  const expanded = renderFetchResult(result, { expanded: true, isPartial: false }, theme, context());
  const output = text(expanded, 60);
  assert(!output.includes("Line 1880"));
  assert(!output.includes("Line 2099"));
  assert(result.content[0].text.includes("Line 1880"));
  assert(output.includes("Content truncated"));
  assert(output.includes("... Preview limited to 40 lines"));
  assert(!output.includes("Full JSON"));
  assert(!output.includes("content.md"));
  assert(expanded.render(60).length <= 47);
});

test("display sanitization does not modify model/codemode response data", async () => {
  const unsafe = "Title\u001b[2J\u001b]0;hostile\u0007\u202e\nNext";
  const page = { title: unsafe, content: "Raw\u001b[31m data" };
  const original = formatFetch(page);
  const result = await makeFetchResult(page);
  assert.equal(result.content[0].text, original);
  assert.equal(result.structuredContent, page);
  assert.equal(result.details.title, "Title Next");
  const output = renderFetchResult(result, { expanded: true, isPartial: false }, theme, context()).render(100).join("\n");
  assert(!output.includes("\u001b[2J"));
  assert(!output.includes("\u001b]0;"));
  assert(!output.includes("\u202e"));
  assert.equal(safeText("a\u0000b\r\nc"), "ab\nc");
});

test("search details stay bounded and never include page bodies", () => {
  const items = buildSearchItems(data);
  assert.equal(items.length, 5);
  assert.equal(items[0].snippet, "Short summary");
  assert(Buffer.byteLength(JSON.stringify(items)) < 24 * 1024);
  assert(!JSON.stringify(items).includes("Body"));
});

test("UI uses snippets only while model text uses summaries only", () => {
  const sample = structuredClone(data);
  sample.results[0].snippet = "UI snippet";
  sample.results[0].summary = "Model summary";
  sample.results[1].snippet = "";
  sample.results[1].summary = "Fallback summary";
  sample.results[2].snippet = "Fallback snippet";
  sample.results[2].summary = "";
  sample.results[3].snippet = "";
  sample.results[3].summary = "";
  const original = structuredClone(sample);
  const items = buildSearchItems(sample);
  assert.equal(items[0].snippet, "UI snippet");
  assert.equal(items[1].snippet, "");
  assert.equal(items[2].snippet, "Fallback snippet");
  assert.equal(items[3].snippet, "");
  const modelText = formatSearch(sample);
  assert(modelText.includes("Model summary"));
  assert(!modelText.includes("UI snippet"));
  assert(!modelText.includes("Fallback snippet"));
  assert.deepEqual(sample, original);
});

test("expanded Markdown can be invalidated and rendered under light theme", async () => {
  initTheme("light", false);
  try {
    const page = { title: "Theme test", content: "## Heading\n\n**bold** and \\`inline\\` code" };
    const result = await makeFetchResult(page);
    const component = renderFetchResult(result, { expanded: true, isPartial: false }, theme, context());
    assert(text(component).includes("Heading"));
    component.invalidate();
    assert(component.render(30).every(line => visibleWidth(line) <= 30));
  } finally { initTheme("dark", false); }
});
