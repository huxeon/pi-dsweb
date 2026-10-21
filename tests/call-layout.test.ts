import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { renderFetchCall, renderSearchCall } from "../src/renderers.ts";
import { FetchParams, SearchParams } from "../src/schemas.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
function context(overrides: Partial<Context> = {}): Context {
  return { args: {}, state: {}, toolCallId: "layout", invalidate() {}, lastComponent: undefined,
    cwd: ".", executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: false, isError: false, durationMs: 1200, outputPad: 0, ...overrides };
}
const rows = (component: Component, width = 80) => component.render(width).map(stripTerminalSequences);
const compactText = (component: Component, width = 80) => rows(component, width).join("").replace(/\s/g, "");
const urlPrefix = "https://example.com/";
const url = urlPrefix + "x".repeat(8192 - urlPrefix.length - "?q=exact%20phrase#END_MARKER".length) + "?q=exact%20phrase#END_MARKER";

test("Fetch keeps and wraps the complete 8192-character URL like a built-in call line", () => {
  const args = { url };
  const original = structuredClone(args);
  assert.equal(url.length, 8192);
  assert(Value.Check(FetchParams, args));
  const folded = renderFetchCall(args, theme, context());
  assert(rows(folded).length > 1);
  assert.equal(compactText(folded), "web_fetch" + url);
  const expanded = renderFetchCall(args, theme, context({ expanded: true, lastComponent: folded }));
  assert.equal(expanded, folded);
  assert.equal(compactText(expanded), "web_fetch" + url);
  for (const width of [1, 2, 8, 24, 80]) assert(expanded.render(width).every(line => visibleWidth(line) <= width));
  expanded.invalidate();
  assert.equal(compactText(expanded, 48), "web_fetch" + url);
  assert.deepEqual(args, original);
});

test("Search always wraps all 128 Unicode characters and preserves search syntax and options", () => {
  const syntax = 'site:github.com OR site:huggingface.co "release notes" -"spam ads" lang:zh after:2025 ';
  const query = syntax + "中".repeat(128 - [...syntax].length - "END_MARKER".length) + "END_MARKER";
  const args = { query, count: 50, need_content: true };
  const original = structuredClone(args);
  assert.equal([...query].length, 128);
  assert(Value.Check(SearchParams, args));
  const folded = renderSearchCall(args, theme, context());
  assert(rows(folded).length > 1);
  for (const width of [8, 24, 48, 80]) {
    const output = compactText(folded, width);
    assert.equal(output, "web_search" + query.replace(/\s/g, "") + "(count50,content)");
    assert(!output.includes("..."));
  }
  const expanded = renderSearchCall(args, theme, context({ expanded: true, lastComponent: folded }));
  assert.equal(expanded, folded);
  const text = compactText(expanded);
  assert(text.includes(query.replace(/\s/g, "")));
  assert(text.includes("count50"));
  assert(text.includes("content"));
  for (const width of [1, 2, 8, 24, 80]) assert(expanded.render(width).every(line => visibleWidth(line) <= width));
  assert.deepEqual(args, original);
});

test("expanded calls stay safe for incomplete arguments and external terminal controls", () => {
  for (const component of [renderSearchCall({}, theme, context({ expanded: true })), renderFetchCall({}, theme, context({ expanded: true }))]) {
    assert.deepEqual(component.render(0), []);
    assert(component.render(8).every(line => visibleWidth(line) <= 8));
  }
  const args = { url: "https://example.com/\u001b[2J\u001b]0;hostile\u0007\u202e" + "x".repeat(400) + "SAFE_END" };
  const original = structuredClone(args);
  const output = renderFetchCall(args, theme, context({ expanded: true })).render(80).join("\n");
  assert(!output.includes("\u001b[2J"));
  assert(!output.includes("\u001b]0;"));
  assert(!output.includes("\u202e"));
  assert(output.includes("SAFE_END"));
  assert.deepEqual(args, original);
});

test("expanded call components refresh arguments and theme without retaining stale text", () => {
  const first = renderFetchCall({ url }, theme, context({ expanded: true }));
  assert(compactText(first).includes("END_MARKER"));
  const styledTheme = { ...theme, bold: (text: string) => "\u001b[1m" + text + "\u001b[22m" } as Theme;
  const second = renderFetchCall({ url: "https://example.org/updated" }, styledTheme, context({ expanded: true, lastComponent: first }));
  assert.equal(first, second);
  const output = second.render(80).join("\n");
  assert(output.includes("\u001b[1mweb_fetch\u001b[22m"));
  assert(output.includes("example.org/updated"));
  assert(!output.includes("END_MARKER"));
  second.invalidate();
  assert(compactText(second, 24).includes("https://example.org/updated"));
});

test("Pi keeps complete call arguments visible before and after expansion without changing inputs", () => {
  const cases = [
    { name: "web_fetch", args: { url }, renderer: renderFetchCall, expected: url },
    { name: "web_search", args: { query: "中".repeat(118) + "END_MARKER" }, renderer: renderSearchCall, expected: "中".repeat(118) + "END_MARKER" },
  ];
  for (const item of cases) {
    const original = structuredClone(item.args);
    const component = new ToolExecutionComponent(item.name, "host-layout", item.args, {},
      { renderCall: item.renderer as NonNullable<ToolDefinition["renderCall"]> }, { requestRender() {} } as unknown as TUI, process.cwd());
    assert(compactText(component).includes(item.expected));
    assert(!compactText(component).includes("..."));
    component.setExpanded(true);
    assert(compactText(component).includes(item.expected));
    component.setExpanded(false);
    assert(compactText(component).includes(item.expected));
    assert(!compactText(component).includes("..."));
    assert.deepEqual(item.args, original);
  }
});
