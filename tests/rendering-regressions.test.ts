import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderFetchResult, renderSearchCall, renderSearchResult } from "../src/renderers.ts";
import { buildSearchItems } from "../src/presentation.ts";
import { makeFetchResult, makeSearchResult } from "./helpers.ts";
import type { SearchData } from "../src/schemas.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const ctx = (overrides: Partial<Context> = {}): Context => ({
  args: { url: "https://example.com" }, state: {}, toolCallId: "test", invalidate() {},
  lastComponent: undefined, cwd: ".", executionStarted: true, argsComplete: true,
  isPartial: false, expanded: false, showImages: false, isError: false, durationMs: 1200,
  outputPad: 0, ...overrides,
});
const options = { expanded: true, isPartial: false };
const plainLines = (component: Component, width = 80) => component.render(width).map(line => stripTerminalSequences(line).trimEnd());
const resultItem = (i: number, content = "body") => ({
  title: `Article ${i}`, url: `https://example.com/${i}`, rerank_score: 2,
  snippet: `Snippet ${i}`, summary: `Summary ${i}`, content,
  site_name: null, site_icon: null, date: null, authority: 3,
});

test("errors preview five visual rows and expand to the full text", () => {
  const longLine = { content: [{ type: "text" as const, text: "HTTP 429: " + "中😀x".repeat(2000) }], details: undefined };
  for (const expanded of [false, true]) {
    const component = renderFetchResult(longLine, { expanded, isPartial: false }, theme, ctx({ isError: true }));
    for (const width of [1, 8, 24, 40, 80]) {
      const lines = component.render(width);
      assert(lines.every(line => visibleWidth(line) <= width));
    }
    assert.equal(component.render(80).at(-1), "Took 1.2s");
  }
  const many = { content: [{ type: "text" as const, text: Array.from({ length: 15 }, (_, i) => `error ${i}`).join("\n") }], details: undefined };
  const folded = plainLines(renderFetchResult(many, { expanded: false, isPartial: false }, theme, ctx({ isError: true }))).join("\n");
  assert(folded.includes("error 4"));
  assert(!folded.includes("error 5"));
  assert(folded.includes("10 more lines"));
  const expanded = plainLines(renderFetchResult(many, options, theme, ctx({ isError: true }))).join("\n");
  assert(expanded.includes("error 14"));
  assert(!expanded.includes("more lines"));
  for (const renderer of [renderSearchResult, renderFetchResult]) {
    const component = renderer(longLine, { expanded: false, isPartial: false }, theme, ctx({ isError: true }));
    for (const width of [24, 40, 80, 32]) {
      const lines = plainLines(component, width);
      const hint = lines.findIndex(line => line.includes("more lines"));
      assert.equal(hint, 5);
      assert.equal(lines.at(-1), "Took 1.2s");
    }
  }
});

test("expanded search has no result-count cap and hides full JSON paths", async () => {
  const data: SearchData = { results: Array.from({ length: 75 }, (_, i) => resultItem(i + 1, i === 0 ? "LONG ARTICLE BODY\n".repeat(200) : "body")) };
  const result = await makeSearchResult(data);
  const component = renderSearchResult(result, options, theme, ctx());
  const output = plainLines(component).join("\n");
  assert(output.includes("Article 1"));
  assert(output.includes("Article 75"));
  assert(output.includes("Snippet 75"));
  assert(!output.includes("Summary 75"));
  assert(Array.isArray(result.details));
  assert(!output.includes("Full JSON"));
  assert(!output.includes("response.json"));
  assert(!output.includes("pi-dsweb-"));
  assert(!output.includes("Showing 50 of"));
  assert.equal(result.details.length, 75);
  assert(!output.includes("LONG ARTICLE BODY"));
  for (const width of [8, 24, 80]) assert(component.render(width).every(line => visibleWidth(line) <= width));
});

test("search renders with only content/details, as forwarded by Pi", async () => {
  const result = await makeSearchResult({ results: [resultItem(1, "")] });
  assert(Array.isArray(result.details));
  const uiResult = { content: result.content, details: result.details };
  const first = renderSearchResult(uiResult, options, theme, ctx());
  assert(plainLines(first).join("\n").includes("Snippet 1"));
  const nextResult = await makeSearchResult({ results: [resultItem(2, "")] });
  const next = renderSearchResult(
    { content: nextResult.content, details: nextResult.details },
    options, theme, ctx({ lastComponent: first }),
  );
  assert.equal(next, first);
  const output = plainLines(next).join("\n");
  assert(output.includes("Article 2"));
  assert(output.includes("Snippet 2"));
  assert(!output.includes("Article 1"));
  assert(!output.includes("Summary 2"));
});

test("malformed search structured data cannot leak model text or break rendering", () => {
  const result = {
    content: [{ type: "text" as const, text: "MODEL TEXT AND FILE PATH MUST STAY HIDDEN" }],
    structuredContent: { results: [{ title: "Incomplete result" }] },
    details: undefined,
  };
  const output = plainLines(renderSearchResult(result, options, theme, ctx())).join("\n");
  assert(output.includes("Search preview unavailable"));
  assert(!output.includes("MODEL TEXT"));
});

test("expanded long fetch titles cannot hide duration or truncation status", async () => {
  const page = { title: "Long title ".repeat(30), content: "x".repeat(60_000) };
  const result = await makeFetchResult(page);
  const component = renderFetchResult(result, options, theme, ctx());
  for (const width of [32, 40, 60]) {
    const lines = plainLines(component, width);
    const output = lines.join("\n");
    assert.equal(lines[0], "");
    assert(lines[1].startsWith("Title: Long title"));
    assert(!lines[1].includes("Took"));
    assert.equal(lines.at(-1), "Took 1.2s");
    assert(output.includes("Truncated:"));
    assert(!output.includes("KiB"));
    assert(!output.includes("example.com"));
    assert(lines.every(line => visibleWidth(line) <= width));
  }
});

test("collapsed search bounds long titles by visual rows and expands remaining fields", async () => {
  const data: SearchData = { results: [{ ...resultItem(1), title: "LONG ".repeat(200) }] };
  const result = await makeSearchResult(data);
  const component = renderSearchResult(result, { expanded: false, isPartial: false }, theme, ctx());
  for (const width of [24, 40, 60]) {
    const lines = plainLines(component, width);
    const output = lines.join("\n");
    assert(output.includes("more lines"));
    assert(!output.includes("example.com"));
    assert(lines.filter(line => line.includes("LONG")).length <= 5);
  }
  const expanded = renderSearchResult(result, options, theme, ctx({ lastComponent: component }));
  const output = plainLines(expanded, 80).join("\n");
  assert(output.includes("example.com"));
  assert(output.includes("Snippet 1"));
});

test("search expand hint appears only when preview lines are hidden", async () => {
  const data: SearchData = { results: Array.from({ length: 5 }, (_, i) => resultItem(i + 1)) };
  const result = await makeSearchResult(data);
  const folded = plainLines(renderSearchResult(result, { expanded: false, isPartial: false }, theme, ctx())).join("\n");
  assert(folded.includes("Article 2"));
  assert(!folded.includes("Article 3"));
  assert(folded.includes("14 more lines"));
  const expanded = plainLines(renderSearchResult(result, options, theme, ctx())).join("\n");
  assert(expanded.includes("Article 5"));
  assert(!expanded.includes("more lines"));
});

test("folded fetch previews the body while model text keeps the complete body", async () => {
  const page = { title: "Many lines", content: "line\n".repeat(200) + "LAST BODY MARKER" };
  const result = await makeFetchResult(page);
  assert.equal(result.structuredContent, page);
  assert.equal(result.details.content, page.content);
  const folded = plainLines(renderFetchResult(result, { expanded: false, isPartial: false }, theme, ctx()), 60).join("\n");
  assert(folded.startsWith("\nTitle: Many lines\n\nline\nline\nline\n"));
  assert(folded.includes("198 more lines"));
  assert(!folded.includes("LAST BODY MARKER"));
  assert(result.content[0].text.includes("LAST BODY MARKER"));
  const expanded = plainLines(renderFetchResult(result, options, theme, ctx()), 60).join("\n");
  assert(expanded.includes("LAST BODY MARKER"));
  assert(!expanded.includes("Content truncated"));
  assert(!expanded.includes("Full JSON"));
});

test("all 50 search items retain complete escaped UTF-8 display fields", () => {
  const data: SearchData = { results: Array.from({ length: 50 }, (_, i) => ({
    ...resultItem(i), title: '😀中"\\'.repeat(500), snippet: '中文"\\'.repeat(500), summary: '中文"\\'.repeat(500), url: 'https://example.com/' + '"\\中'.repeat(500),
  })) };
  const view = buildSearchItems(data);
  assert.equal(view.length, 50);
  for (const [index, item] of view.entries()) {
    assert.equal(item.title, data.results[index].title);
    assert.equal(item.url, data.results[index].url);
    assert.equal(item.snippet, data.results[index].snippet);
  }
  assert(!JSON.stringify(view).includes('"content"'));
});

test("result components are reused across expansion and redraw", async () => {
  const page = { title: "Cache", content: "## A heading\n\nSome **Markdown**." };
  const result = await makeFetchResult(page);
  const first = renderFetchResult(result, options, theme, ctx());
  const expanded = plainLines(first).join("\n");
  assert(expanded.includes("A heading"));
  assert(expanded.includes("Some **Markdown**"));
  const second = renderFetchResult(result, options, theme, ctx({ lastComponent: first }));
  assert.equal(first, second);
  renderFetchResult(result, { expanded: false, isPartial: false }, theme, ctx({ lastComponent: second }));
  const reused = renderFetchResult(result, options, theme, ctx({ lastComponent: second }));
  assert.equal(reused, first);
  first.invalidate();
  assert(plainLines(first).join("\n").includes("A heading"));
});

test("new content or theme refreshes displayed text without replacing the result component", async () => {
  const page = { title: "Cache", content: "Old content" };
  const firstResult = await makeFetchResult(page);
  const component = renderFetchResult(firstResult, options, theme, ctx());
  assert(plainLines(component).join("\n").includes("Old content"));
  const next = await makeFetchResult({ ...page, content: "New content" });
  const same = renderFetchResult(next, options, theme, ctx({ lastComponent: component }));
  assert.equal(same, component);
  const text = plainLines(same).join("\n");
  assert(text.includes("New content"));
  assert(!text.includes("Old content"));
  const styledTheme = { ...theme, fg: (color: string, value: string) => color === "toolOutput" ? `<${value}>` : value } as Theme;
  const changed = renderFetchResult(next, options, styledTheme, ctx({ lastComponent: same }));
  assert.equal(changed, component);
  assert(changed.render(100).join("\n").includes("<Title: Cache>"));
});

test("call components are reused and display updated arguments", () => {
  const first = renderSearchCall({ query: "first" }, theme, ctx());
  const second = renderSearchCall({ query: "second" }, theme, ctx({ lastComponent: first }));
  assert.equal(first, second);
  const output = plainLines(second).join("\n");
  assert(output.includes("second"));
  assert(!output.includes("first"));
});

test("search no longer accepts legacy object details", () => {
  const oldView = { kind: "search" as const, count: 5, items: [{ title: "OLD TITLE", domain: "example.com" }] };
  for (const details of [oldView, { truncated: true, view: oldView }]) {
    const result = { content: [{ type: "text" as const, text: "OLD MODEL TEXT" }], details };
    const output = plainLines(renderSearchResult(result, options, theme, ctx())).join("\n");
    assert(output.includes("Search preview unavailable."));
    assert(!output.includes("OLD TITLE"));
    assert(!output.includes("OLD MODEL TEXT"));
    assert(!output.includes("Showing"));
    assert(!output.includes("Content truncated"));
    assert(!output.includes("Full JSON"));
  }
});

test("fetch only needs file access when its body is truncated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dsweb-blocked-test-"));
  const blocker = join(dir, "not-a-directory");
  await writeFile(blocker, "test");
  const names = ["TMPDIR", "TMP", "TEMP"];
  const previous = names.map(name => process.env[name]);
  t.after(async () => {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
    await rm(dir, { recursive: true, force: true });
  });
  names.forEach(name => { process.env[name] = blocker; });
  const page = { title: "Small", content: "body" };
  const result = await makeFetchResult(page);
  assert.equal(result.details.truncated, false);
  assert.equal(result.structuredContent, page);
  assert(plainLines(renderFetchResult(result, options, theme, ctx())).join("\n").includes("body"));
  await assert.rejects(makeFetchResult({ title: "Large", content: "x".repeat(60_000) }));
});
