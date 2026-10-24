import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { formatSearch } from "../src/output.ts";
import { fetchBodyPaths, makeFetchResult, makeSearchResult, trackResult } from "./helpers.ts";
import { FetchResponse, SearchParams, SearchResponse, type SearchData } from "../src/schemas.ts";

const sample: SearchData = { results: [{
  title: "示例文章", url: "https://example.com/article", rerank_score: 2.4,
  snippet: "短摘要", summary: "长摘要", content: "# 正文", site_name: null,
  site_icon: null, date: null, authority: -1,
}] };

function collectTools() {
  const tools: ToolDefinition[] = [];
  extension({ on: () => () => {}, registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as unknown as ExtensionAPI);
  return tools;
}

test("factory only registers two namespaced read-only direct tools", () => {
  const tools = collectTools();
  assert.deepEqual(tools.map(t => t.name), ["web_search", "web_fetch"]);
  assert.deepEqual(tools.map(t => t.label), ["Web Search", "Web Fetch"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.namespace?.name, "dsweb");
    const modelFacingMetadata = JSON.stringify({
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
      namespace: tool.namespace,
    });
    assert(!/deepseek/i.test(modelFacingMetadata));
    assert(tool.outputSchema);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
    assert(tool.promptSnippet?.trim());
    assert(!/[\r\n]/.test(tool.promptSnippet!));
    assert(tool.exposure === undefined || tool.exposure === "direct");
  }
});

test("request and response schemas accept official examples", () => {
  assert(Value.Check(SearchParams, { query: "😀".repeat(128), ori_question: null, need_content: false, count: 50 }));
  assert(Value.Check(SearchResponse, sample));
  assert(Value.Check(SearchResponse, { results: [] }));
  assert(Value.Check(FetchResponse, { title: "", content: "# Markdown" }));
  assert(!Value.Check(SearchResponse, { results: [{ title: "missing fields" }] }));
  assert(!Value.Check(SearchParams, { query: "hi", unknown: true }));
});

test("search formatting retains metadata and summary but excludes page bodies", () => {
  const text = formatSearch(sample);
  for (const part of ["示例文章", "https://example.com/article", "Score: 2.4", "Authority: -1", "长摘要"]) assert(text.includes(part));
  assert(!text.includes("# 正文"));
  assert(!text.includes("短摘要"));
  assert.equal(formatSearch({ results: [] }), "No matching web results.");
});

test("search exposes the raw API response as structured output", async () => {
  const result = await makeSearchResult(sample);
  assert.equal(result.structuredContent, sample);
  assert(Value.Check(SearchResponse, result.structuredContent));
  assert.deepEqual(collectTools()[0].outputSchema, SearchResponse);
});

test("large fetch bodies are bounded in text, saved as Markdown, and raw in codemode", async () => {
  const page = { title: "Large", content: "你好😀".repeat(20_000) };
  const result = await makeFetchResult(page);
  const file = fetchBodyPaths(result)[0];
  assert(file);
  assert.equal(result.details.truncated, true);
  assert.equal(result.structuredContent, page);
  assert(Buffer.byteLength(result.details.content) <= 48 * 1024);
  assert(Buffer.byteLength(result.content[0].text) < 50 * 1024);
  assert.equal(await readFile(file, "utf8"), page.content);
  assert(Value.Check(FetchResponse, result.structuredContent));
  assert.deepEqual(collectTools()[1].outputSchema, FetchResponse);
});

test("many body lines trigger fetch truncation even below byte limit", async () => {
  const page = { title: "Lines", content: "x\n".repeat(2100) };
  const result = await makeFetchResult(page);
  assert.equal(result.details.truncated, true);
  assert(result.content[0].text.split("\n").length <= 2000);
  assert.equal(result.structuredContent, page);
});

test("large raw search fields are returned intact without a preview wrapper", async () => {
  const data = structuredClone(sample);
  data.results[0].snippet = "x".repeat(60_000);
  const result = await makeSearchResult(data);
  assert.equal(result.structuredContent, data);
  assert.equal(result.structuredContent.results[0].snippet.length, 60_000);
  assert(Array.isArray(result.details));
  assert(!("preview" in result.structuredContent));
});

test("registered tools execute with mocked transport and reject malformed API data", async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-offline-test";
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });
  const tools = collectTools();
  const transport = t.mock.method(globalThis, "fetch", async (url: string) => new Response(JSON.stringify(url.endsWith("search") ? sample : { title: "Article", content: "# Markdown" })));
  const signal = new AbortController().signal;
  const search = trackResult(await tools[0].execute("search-test", { query: "hello", count: 1 }, signal, undefined, {} as never));
  assert(search.content[0].type === "text" && search.content[0].text.includes("长摘要"));
  assert.deepEqual(search.structuredContent, sample);
  assert(search.content[0].type === "text" && !search.content[0].text.includes("# 正文"));
  const page = trackResult(await tools[1].execute("fetch-test", { url: "https://example.com" }, signal, undefined, {} as never));
  assert(page.content[0].type === "text" && page.content[0].text.includes("# Markdown"));
  assert.deepEqual(page.structuredContent, { title: "Article", content: "# Markdown" });
  assert(page.content[0].type === "text" && !page.content[0].text.includes("https://example.com"));
  transport.mock.mockImplementation(async () => new Response(JSON.stringify({ results: "wrong" })));
  await assert.rejects(tools[0].execute("bad", { query: "hi" }, signal, undefined, {} as never), /unexpected response schema/);
});

test("package manifest exposes only the extension entrypoint and host peers", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "pi-dsweb");
  assert(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert(manifest.files.includes("index.ts"));
  assert(manifest.files.includes("src/"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.dependencies, undefined);
});
