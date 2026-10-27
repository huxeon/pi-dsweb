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
const text = (component: Component, width = 100) => component.render(width).map(line => stripTerminalSequences(line).trimEnd()).join("\n");
const data: SearchData = { results: Array.from({ length: 5 }, (_, index) => ({
  title: `Article ${index + 1}`, url: `https://example.com/${index}`, rerank_score: 2,
  snippet: "Short summary", summary: `Long summary ${index + 1}`, content: "Body",
  site_name: null, site_icon: null, date: null, authority: 3,
})) };

test("call renderers use Pi-style tool names and compact parameters", () => {
  const search = text(renderSearchCall({ query: "中文搜索 😀", count: 3, need_content: true }, theme, context({ isPartial: true })));
  assert(search.includes("web_search"));
  assert(search.includes("中文搜索 😀"));
  assert(search.includes("count 3"));
  assert(search.includes("content"));
  assert(!search.includes("Searching"));
  assert.equal(search, text(renderSearchCall({ query: "中文搜索 😀", count: 3, need_content: true }, theme, context())));
  const fetch = text(renderFetchCall({ url: "https://example.com/article" }, theme, context({ isPartial: true })));
  assert(fetch.includes("web_fetch"));
  assert(fetch.includes("https://example.com/article"));
  assert(!fetch.includes("Fetching"));
  assert.equal(fetch, text(renderFetchCall({ url: "https://example.com/article" }, theme, context())));
});

test("incomplete arguments are safe and calls fit narrow terminal widths", () => {
  for (const component of [renderSearchCall({}, theme, context()), renderFetchCall({}, theme, context()), renderSearchCall({ query: "中😀".repeat(200) }, theme, context())]) {
    for (const width of [1, 8, 24, 80]) {
      assert(component.render(width).every(line => visibleWidth(line) <= width));
    }
    assert.deepEqual(component.render(0), []);
  }
});

test("collapsed search previews five output lines and expands the rest", async () => {
  const result = await makeSearchResult(data);
  const output = text(renderSearchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(output.startsWith("\n1. "));
  assert(!output.includes("5 results"));
  assert(output.includes("Article 2"));
  assert(!output.includes("https://example.com/1"));
  assert(output.includes("Short summary"));
  assert(!output.includes("Article 4"));
  assert(!output.includes("Long summary"));
  assert(output.includes("14 more lines"));
  assert(output.includes("1.2s"));
});

test("empty search is a successful empty state, not a failure", async () => {
  const result = await makeSearchResult({ results: [] });
  const output = text(renderSearchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(output.includes("No matching web results"));
  assert(!output.includes("failed"));
});

test("fetch renders the model text as plain toolOutput lines without a size line", async () => {
  const result = await makeFetchResult({ title: "Page title", content: "Page body" });
  const styledTheme = { ...theme, bold: (value: string) => "\x1b[1m" + value + "\x1b[22m" } as Theme;
  const folded = renderFetchResult(result, { expanded: false, isPartial: false }, styledTheme, context());
  const collapsedRows = folded.render(100).map(line => line.trimEnd());
  assert.deepEqual(collapsedRows, ["", "Title: Page title", "", "Page body", "", "Took 1.2s"]);
  const expanded = renderFetchResult(result, { expanded: true, isPartial: false }, styledTheme, context({ lastComponent: folded }));
  assert.equal(expanded, folded);
  const expandedRows = expanded.render(100).map(line => line.trimEnd());
  assert.equal(expandedRows[0], "");
  assert.equal(expandedRows[1], "Title: Page title");
  assert.equal(expandedRows[2], "");
  assert(expandedRows.map(stripTerminalSequences).join("\n").includes("Page body"));
});

test("collapsed small fetch shows the full page text and timing without an expand hint", async () => {
  const page = { title: "A page", content: "Private body 中😀" };
  const result = await makeFetchResult(page);
  const output = text(renderFetchResult(result, { expanded: false, isPartial: false }, theme, context({ args: { url: "https://example.com" } })));
  assert.equal(output, "\nTitle: A page\n\nPrivate body 中😀\n\nTook 1.2s");
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

test("partial results without a started clock stay empty; failures remain explicit", () => {
  const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "HTTP 429: wait before retrying" }], details: undefined };
  for (const renderer of [renderSearchResult, renderFetchResult]) {
    assert.deepEqual(renderer(result, { expanded: false, isPartial: true }, theme, context({ executionStarted: false })).render(80), []);
    const output = text(renderer(result, { expanded: false, isPartial: false }, theme, context({ isError: true })));
    assert(output.includes("HTTP 429"));
    assert(!output.includes("completed"));
  }
});

test("malformed search details fail closed without throwing or leaking model text", () => {
  const valid = buildSearchItems(data)[0];
  const malformed: unknown[] = [
    undefined, null, {}, [null], [123], [[]], [{}], new Array(1),
    ...["title", "url", "snippet"].flatMap(field => [
      [{ ...valid, [field]: null }],
      [{ ...valid, [field]: 123 }],
    ]),
    [valid, { ...valid, snippet: false }],
  ];
  for (const details of malformed) {
    for (const expanded of [false, true]) {
      const result = { content: [{ type: "text" as const, text: "PRIVATE MODEL SUMMARY /tmp/private.md" }], details };
      const output = text(renderSearchResult(result, { expanded, isPartial: false }, theme, context()));
      assert(output.includes("Search preview unavailable."));
      assert(!output.includes("PRIVATE MODEL"));
      assert(!output.includes(valid.title));
    }
  }
});

test("fetch does not fall back to model text for obsolete details", () => {
  const result = { content: [{ type: "text" as const, text: "Legacy response text" }], details: { truncated: false } };
  const output = text(renderFetchResult(result, { expanded: true, isPartial: false }, theme, context()));
  assert(output.includes("Page preview unavailable"));
  assert(!output.includes("Legacy response text"));
});

test("fetch rejects inconsistent truncation details without exposing model text", () => {
  const base = { title: "Page", content: "body", totalLines: 2, outputLines: 1 };
  const invalid = [
    { ...base, truncated: true },
    { ...base, truncated: true, truncatedBy: "lines" },
    { ...base, truncated: true, truncatedBy: "bytes", fullOutputPath: "" },
    { ...base, truncated: true, truncatedBy: "invalid", fullOutputPath: "file.md" },
    { ...base, truncated: false, truncatedBy: "lines", fullOutputPath: "file.md" },
  ];
  for (const details of invalid) {
    const result = { content: [{ type: "text" as const, text: "PRIVATE MODEL TEXT" }], details };
    for (const expanded of [false, true]) {
      const output = text(renderFetchResult(result, { expanded, isPartial: false }, theme, context()));
      assert(output.includes("Page preview unavailable"));
      assert(!output.includes("PRIVATE MODEL TEXT"));
    }
  }
});

test("folded fetch previews five lines; expansion shows the model-visible body and warning", async () => {
  const page = { title: "Large page", content: Array.from({ length: 2100 }, (_, i) => `Line ${i}`).join("\n") };
  const result = await makeFetchResult(page);
  assert(result.details.truncated);
  const collapsed = text(renderFetchResult(result, { expanded: false, isPartial: false }, theme, context()));
  assert(collapsed.startsWith("\nTitle: Large page\n\nLine 0\nLine 1\nLine 2\n"));
  assert(!collapsed.includes("\nLine 3\n"));
  assert(collapsed.includes("1997 more lines"));
  assert(collapsed.includes("Full output:"));
  assert(collapsed.replace(/\s/g, "").includes("Truncated:showing2000of2100lines]"));
  const output = text(renderFetchResult(result, { expanded: true, isPartial: false }, theme, context()), 60);
  assert(output.includes("Line 1880"));
  assert(!output.includes("Line 2099"));
  assert(result.content[0].text.includes("Line 1880"));
  assert(output.replace(/\s/g, "").includes("Truncated:showing2000of2100lines]"));
  assert(output.includes("Full output:"));
  assert(!output.includes("Preview limited"));
  assert(!output.includes("Full JSON"));
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

test("search details contain display fields without long summaries or page bodies", () => {
  const items = buildSearchItems(data);
  assert.equal(items.length, 5);
  assert.equal(items[0].snippet, "Short summary");
  assert.deepEqual(Object.keys(items[0]), ["title", "url", "snippet"]);
  assert(!JSON.stringify(items).includes("Long summary"));
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

test("both tools preview five visual rows and preserve that prefix on expansion", async () => {
  for (const length of [5, 6]) {
    const body = Array.from({ length: length }, (_, i) => `body ${i}`).join("\n");
    const fetch = await makeFetchResult({ title: "", content: body });
    // One title + URL + three/four snippet lines makes five/six output lines.
    const search = await makeSearchResult({ results: [{
      ...data.results[0], content: "",
      snippet: Array.from({ length: length - 2 }, (_, i) => `snippet ${i}`).join("\n"),
    }] });
    for (const [renderer, result] of [[renderFetchResult, fetch], [renderSearchResult, search]] as const) {
      const original = structuredClone(result);
      const folded = renderer(result, { expanded: false, isPartial: false }, theme, context());
      const foldedRows = text(folded).split("\n");
      const prefix = foldedRows.slice(1, 6);
      assert.equal(prefix.length, 5);
      assert.equal(foldedRows.some(row => row.includes("more line")), length > 5);
      if (length > 5) assert(foldedRows[6].includes("1 more line,"));
      assert.equal(foldedRows.at(-1), "Took 1.2s");
      const expanded = renderer(result, { expanded: true, isPartial: false }, theme, context({ lastComponent: folded }));
      assert.equal(expanded, folded);
      const expandedRows = text(expanded).split("\n");
      assert.deepEqual(expandedRows.slice(1, 6), prefix);
      assert(!expandedRows.some(row => row.includes("more line")));
      assert.deepEqual(result, original);
    }
  }
});

test("Fetch UI and model share the same title/body layout without altering raw escapes", async () => {
  for (const title of ["Page", "", "  ", "Page\nsecond line"]) {
    const page = { title, content: String.raw`\# Heading

need\_content` };
    const result = await makeFetchResult(page);
    const output = text(renderFetchResult(result, { expanded: true, isPartial: false }, theme, context()));
    assert.equal(output, `\n${result.content[0].text}\n\nTook 1.2s`);
    assert.equal(result.structuredContent.content, page.content);
  }
});

test("expanded fetch can be invalidated and rendered under light theme", async () => {
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
