import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import extension from "../index.ts";
import { makeFetchResult, makeSearchResult } from "./helpers.ts";

initTheme("dark", false);

test("Pi's actual tool component displays search results without forwarding structuredContent", async () => {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
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
  assert.deepEqual(Object.keys(result.details[0]), ["title", "url", "snippet"]);
  component.updateResult({ ...result, isError: false, durationMs: 1200 });
  const output = () => component.render(100).map(stripTerminalSequences).join("\n");
  const collapsed = output();
  assert(!collapsed.includes("2 results"));
  assert(collapsed.includes("Article 1"));
  assert(collapsed.includes("example.com"));
  assert(collapsed.includes("UI snippet 1"));
  component.setExpanded(true);
  const expanded = output();
  for (const text of ["Article 1", "Article 2", "UI snippet 1", "UI snippet 2", "https://example.com/2"]) assert(expanded.includes(text));
  for (const text of ["MODEL SUMMARY", "PRIVATE PAGE BODY", "pi-dsweb-search-", "result-1.md"]) assert(!expanded.includes(text));
  assert(received);
  assert.equal(received.structuredContent, undefined);
  assert.deepEqual(Object.keys(received).sort(), ["content", "details"]);
  assert.equal(received.details, result.details);
});

test("Search bounds long URLs by visual rows and recalculates on resize", async () => {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  const search = tools.find(tool => tool.name === "web_search")!;
  const url = "https://example.com/" + "path/".repeat(200) + "URL_END";
  const result = await makeSearchResult({ results: [{
    title: "Title", url, rerank_score: 2, snippet: "Snippet", summary: "Summary", content: "",
    site_name: null, site_icon: null, date: null, authority: 3,
  }] });
  const component = new ToolExecutionComponent("web_search", "search-visual", { query: "test" }, {},
    search, { requestRender() {} } as unknown as TUI, process.cwd());
  component.updateResult({ ...result, isError: false });
  for (const width of [40, 100, 32, 80]) {
    const rows = component.render(width).map(stripTerminalSequences);
    const output = rows.join("\n");
    assert(output.includes("more lines"));
    assert(!output.includes("URL_END"));
    assert(!output.includes("Snippet"));
    assert(rows.filter(row => row.includes("path/")).length <= 5);
  }
  component.setExpanded(true);
  const expanded = component.render(80).map(stripTerminalSequences).join("").replace(/\s/g, "");
  assert(expanded.includes(url));
  assert(expanded.includes("Snippet"));
});

test("Fetch bounds a long first line by visual rows and retains the warning on resize and expansion", async () => {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  const fetch = tools.find(tool => tool.name === "web_fetch")!;
  const result = await makeFetchResult({ title: "Page", content: "x".repeat(60_000) });
  assert(result.details.truncated);
  const component = new ToolExecutionComponent("web_fetch", "visual-preview", { url: "https://example.com" }, {},
    fetch, { requestRender() {} } as unknown as TUI, process.cwd());
  component.updateResult({ ...result, isError: false, durationMs: 1200 });
  for (const width of [40, 100, 32, 80]) {
    const rows = component.render(width).map(stripTerminalSequences);
    const compact = rows.join("").replace(/\s/g, "");
    assert(compact.includes(result.details.fullOutputPath!.replace(/\s/g, "")));
    assert(compact.includes("Truncated:1linesshown(50.0KBlimit)"));
    assert(compact.includes("morelines"));
    assert(rows.filter(row => /^x+$/.test(row.trim())).length <= 5);
  }
  component.setExpanded(true);
  const expanded = component.render(80).map(stripTerminalSequences).join("").replace(/\s/g, "");
  assert(expanded.includes("x".repeat(50 * 1024)));
  assert(expanded.includes(result.details.fullOutputPath!.replace(/\s/g, "")));
  assert(expanded.includes("Truncated:1linesshown(50.0KBlimit)"));
});

test("Fetch shows byte-limit warnings for complete-line excerpts in both UI states", async () => {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  const fetch = tools.find(tool => tool.name === "web_fetch")!;
  const result = await makeFetchResult({ title: "Page", content: "first\n" + "x".repeat(50 * 1024) });
  assert(result.details.truncated);
  const component = new ToolExecutionComponent("web_fetch", "byte-preview", { url: "https://example.com" }, {},
    fetch, { requestRender() {} } as unknown as TUI, process.cwd());
  component.updateResult({ ...result, isError: false });
  for (const expanded of [false, true]) {
    component.setExpanded(expanded);
    const text = component.render(32).map(stripTerminalSequences).join("").replace(/\s/g, "");
    assert(text.includes(result.details.fullOutputPath!.replace(/\s/g, "")));
    assert(text.includes("Truncated:1linesshown(50.0KBlimit)"));
    assert(text.includes("first"));
  }
});

test("Pi's Fetch component previews five lines and expands the body", async () => {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
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
    assert(collapsed.includes("web_fetch"));
    assert(collapsed.includes("https://example.com/article"));
    assert(collapsed.includes("Title: UNIQUE PAGE TITLE"));
    assert(collapsed.includes("Body line 2"));
    assert(!collapsed.includes("Body line 3"));
    assert(collapsed.includes("more lines"));
    assert.equal(collapsed.includes("Truncated:"), result.details.truncated);
    assert(collapsed.includes("Took 1.2s"));
    component.setExpanded(true);
    const expanded = output();
    assert(expanded.includes("Body line 20"));
    assert(expanded.indexOf("Took 1.2s") > expanded.indexOf("Body line 20"));
    assert(expanded.indexOf("UNIQUE PAGE TITLE") < expanded.indexOf("Body line 20"));
    const expandedRows = expanded.split("\n").map(row => row.trim());
    assert.equal(expandedRows.filter(Boolean).at(-1), "Took 1.2s");
    const expandedTitleIndex = expandedRows.findIndex(row => row === "Title: UNIQUE PAGE TITLE");
    assert(expandedTitleIndex > 0);
    assert.equal(expandedRows[expandedTitleIndex - 1], "");
    assert.equal(expandedRows[expandedTitleIndex + 1], "");
    assert.equal(expanded.split("UNIQUE PAGE TITLE").length - 1, 1);
    assert.equal(expanded.split("https://example.com/article").length - 1, 1);
    assert(!expanded.includes("Preview limited"));
    assert(!expanded.includes("Full JSON"));
    if (result.details.truncated) {
      const compact = expanded.replace(/\s/g, "");
      assert(compact.includes(`Truncated:showing${result.details.outputLines}of${result.details.totalLines}lines]`));
      assert(compact.includes(result.details.fullOutputPath!.replace(/\s/g, "")));
      assert(expanded.includes("Body line 1880"));
      assert(!expanded.includes("FINAL BODY MARKER"));
      assert(result.content[0].text.includes("Body line 1880"));
    } else {
      assert(expanded.includes("FINAL BODY MARKER"));
      assert(result.content[0].text.includes("FINAL BODY MARKER"));
      assert(!expanded.includes("Truncated"));
    }
    assert.equal(result.structuredContent, response);
    if (!result.details.truncated) assert.deepEqual(Object.keys(result.details),
      ["title", "content", "totalLines", "outputLines", "truncated"]);
  }
});
