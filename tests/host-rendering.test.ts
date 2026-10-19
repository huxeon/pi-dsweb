import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import extension from "../extensions/index.ts";
import { makeFetchResult, makeSearchResult } from "./helpers.ts";

initTheme("dark", false);

test("Pi's actual tool component displays search results without forwarding structuredContent", async () => {
  const tools: ToolDefinition[] = [];
  extension({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  const search = tools.find(tool => tool.name === "web_search")!;
  let received: AgentToolResult<unknown> | undefined;
  const renderResult: NonNullable<ToolDefinition["renderResult"]> = (...args) => {
    received = args[0];
    return search.renderResult!(...args);
  };
  const component = new ToolExecutionComponent(
    "web_search", "host-test", { query: "test query" }, {},
    { ...search, renderResult }, { requestRender() {} } as unknown as TUI, process.cwd(),
  );
  const result = await makeSearchResult({ results: [1, 2].map(index => ({
    title: `Article ${index}`, url: `https://example.com/${index}`, rerank_score: 2,
    snippet: `UI snippet ${index}`, summary: `MODEL SUMMARY ${index}`, content: "PRIVATE PAGE BODY",
    site_name: null, site_icon: null, date: null, authority: 3,
  })) });
  assert(Array.isArray(result.details));
  assert.equal(result.details.length, 2);
  assert.deepEqual(Object.keys(result.details[0]), ["title", "domain", "url", "snippet"]);
  component.updateResult({ ...result, isError: false, durationMs: 1200 });
  const output = () => component.render(100).map(stripTerminalSequences).join("\n");
  const collapsed = output();
  assert(collapsed.includes("2 results"));
  assert(collapsed.includes("Article 1"));
  assert(collapsed.includes("example.com"));
  assert(!collapsed.includes("UI snippet"));
  component.setExpanded(true);
  const expanded = output();
  for (const text of ["Article 1", "Article 2", "UI snippet 1", "UI snippet 2", "https://example.com/2"]) assert(expanded.includes(text));
  for (const text of ["MODEL SUMMARY", "PRIVATE PAGE BODY", "pi-dsweb-search-", "result-1.md"]) assert(!expanded.includes(text));
  assert(received);
  assert.equal(received.structuredContent, undefined);
  assert.deepEqual(Object.keys(received).sort(), ["content", "details"]);
  assert.equal(received.details, result.details);
});

test("Pi's Fetch component shows at most 40 body rows without extra URL, title, or file footer", async () => {
  const tools: ToolDefinition[] = [];
  extension({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  const fetch = tools.find(tool => tool.name === "web_fetch")!;
  for (const count of [30, 300, 2100]) {
    const content = Array.from({ length: count }, (_, i) => `Body line ${i}`).join("\n") + "\nFINAL BODY MARKER";
    const response = { title: "UNIQUE PAGE TITLE", content };
    const result = await makeFetchResult(response);
    const component = new ToolExecutionComponent(
      "web_fetch", `fetch-${count}`, { url: "https://example.com/article" }, {},
      fetch, { requestRender() {} } as unknown as TUI, process.cwd(),
    );
    component.updateResult({ ...result, isError: false, durationMs: 1200 });
    const output = () => component.render(100).map(stripTerminalSequences).join("\n");
    const collapsed = output();
    assert(collapsed.includes("UNIQUE PAGE TITLE"));
    assert(collapsed.includes(count === 30 ? " B" : "KiB"));
    assert(collapsed.includes("1.2s"));
    assert(!collapsed.includes("Body line"));
    const collapsedRows = collapsed.split("\n");
    const metadataIndex = collapsedRows.findIndex(row => row.includes("1.2s"));
    const titleIndex = collapsedRows.findIndex(row => row.includes("UNIQUE PAGE TITLE"));
    assert(metadataIndex >= 0 && titleIndex > metadataIndex);
    if (result.details.truncated) {
      const warningIndex = collapsedRows.findIndex(row => row.includes("Content truncated"));
      assert(warningIndex > metadataIndex && warningIndex < titleIndex);
    }
    component.setExpanded(true);
    const expanded = output();
    assert(expanded.includes("Body line 20"));
    assert(expanded.indexOf("1.2s") < expanded.indexOf("UNIQUE PAGE TITLE"));
    assert(expanded.indexOf("UNIQUE PAGE TITLE") < expanded.indexOf("Body line 20"));
    const expandedRows = expanded.split("\n").map(row => row.trim());
    const expandedTitleIndex = expandedRows.findIndex(row => row === "UNIQUE PAGE TITLE");
    assert(expandedTitleIndex > 0);
    assert.equal(expandedRows[expandedTitleIndex - 1], "");
    assert.equal(expandedRows[expandedTitleIndex + 1], "");
    assert.equal(expanded.split("UNIQUE PAGE TITLE").length - 1, 1);
    assert.equal(expanded.split("https://example.com/article").length - 1, 1);
    assert.equal(expanded.includes("... Preview limited to 40 lines"), count > 40);
    assert(!expanded.includes("Full JSON"));
    assert(!expanded.includes("content.md"));
    if (result.details.truncated) {
      assert(expanded.includes("⚠ Content truncated for model"));
      assert(!expanded.includes("Body line 1880"));
      assert(result.content[0].text.includes("Body line 1880"));
      assert(!expanded.includes("FINAL BODY MARKER"));
    } else {
      assert.equal(expanded.includes("FINAL BODY MARKER"), count <= 40);
      assert(result.content[0].text.includes("FINAL BODY MARKER"));
      assert(!expanded.includes("Content truncated"));
    }
    assert.equal(result.structuredContent, response);
    assert.deepEqual(Object.keys(result.details), ["title", "bytes", "content", "truncated"]);
  }
});
