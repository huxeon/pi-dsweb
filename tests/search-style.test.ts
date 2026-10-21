import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderSearchResult } from "../src/renderers.ts";
import { makeSearchResult } from "./helpers.ts";

initTheme("dark", false);
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const context = (): Context => ({
  args: {}, state: {}, toolCallId: "style", invalidate() {}, lastComponent: undefined,
  cwd: ".", executionStarted: true, argsComplete: true, isPartial: false,
  expanded: false, showImages: false, isError: false, durationMs: 1200, outputPad: 0,
});
function recordingTheme() {
  const calls: { color: string; text: string }[] = [];
  const theme = {
    fg: (color: string, text: string) => { calls.push({ color, text: stripTerminalSequences(text) }); return text; },
    bold: (text: string) => "\x1b[1m" + text + "\x1b[22m",
  } as Theme;
  return { theme, calls };
}
const data = { results: [1, 2].map(i => ({
  title: `Title ${i}`, url: `https://example.com/${i}`, snippet: `Snippet ${i}`,
  summary: `Model summary ${i}`, content: "", rerank_score: 2, authority: 3,
  site_name: null, site_icon: null, date: null,
})) };

test("search results use uniform Pi toolOutput lines and separated entries", async () => {
  const result = await makeSearchResult(data);
  const original = structuredClone(result);
  const { theme, calls } = recordingTheme();
  const component = renderSearchResult(result, { expanded: true, isPartial: false }, theme, context());
  const rows = component.render(100);
  const plain = rows.map(row => stripTerminalSequences(row).trimEnd());
  assert.equal(plain[0], "");
  assert.equal(plain[1], "1. Title 1");
  assert.equal(plain[2], "https://example.com/1");
  assert.equal(plain[3], "Snippet 1");
  assert.equal(plain[4], "");
  assert.equal(plain[5], "2. Title 2");
  assert.equal(plain.at(-1), "Took 1.2s");
  assert(!plain.join("\n").includes("results"));
  assert(!rows.some(row => row.includes("\x1b[1m")));
  assert(!calls.some(call => call.color === "success"));
  for (const text of ["1. Title 1", "https://example.com/1", "Snippet 1"]) {
    assert(calls.some(call => call.color === "toolOutput" && call.text === text));
  }
  assert(calls.some(call => call.color === "muted" && call.text === "Took 1.2s"));
  for (const width of [1, 8, 24, 80]) assert(component.render(width).every(row => visibleWidth(row) <= width));
  assert.deepEqual(result, original);
});

test("small search results are fully visible without an expand hint and empty search remains muted", async () => {
  const result = await makeSearchResult({ results: data.results.slice(0, 1) });
  const { theme, calls } = recordingTheme();
  const rows = renderSearchResult(result, { expanded: false, isPartial: false }, theme, context()).render(100);
  const plain = rows.map(row => stripTerminalSequences(row).trimEnd());
  assert.equal(plain[0], "");
  assert.equal(plain.at(-2), "");
  assert.equal(plain[1], "1. Title 1");
  assert.equal(plain[2], "https://example.com/1");
  assert.equal(plain[3], "Snippet 1");
  assert(!plain.join("\n").includes("to expand"));
  assert(!rows.some(row => row.includes("\x1b[1m")));
  calls.length = 0;
  const empty = await makeSearchResult({ results: [] });
  const output = renderSearchResult(empty, { expanded: true, isPartial: false }, theme, context()).render(100)
    .map(row => stripTerminalSequences(row).trimEnd());
  assert.equal(output.length, 4);
  assert.equal(output[0], "");
  assert.equal(output[2], "");
  assert.equal(output.at(-1), "Took 1.2s");
  assert(output[1].includes("No matching web results"));
  assert(!output[1].includes("\x1b[1m"));
  assert(calls.some(call => call.color === "muted" && call.text === "No matching web results"));
  assert(!calls.some(call => call.color === "success"));
});
