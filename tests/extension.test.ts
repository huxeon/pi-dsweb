import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { formatFetch, formatSearch, makeResult } from "../src/output.ts";
import { FetchResponse, SearchParams, SearchResponse, resultSchema, type SearchData } from "../src/schemas.ts";

const sample: SearchData = { results: [{
  title: "示例文章", url: "https://example.com/article", rerank_score: 2.4,
  snippet: "短摘要", summary: "长摘要", content: "# 正文", site_name: null,
  site_icon: null, date: null, authority: -1,
}] };

function collectTools() {
  const tools: ToolDefinition[] = [];
  extension({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as unknown as ExtensionAPI);
  return tools;
}

test("factory only registers two namespaced read-only direct tools", () => {
  const tools = collectTools();
  assert.deepEqual(tools.map(t => t.name), ["deepseek_search", "deepseek_fetch"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.namespace?.name, "deepseek_web");
    assert(tool.outputSchema);
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

test("search formatting retains URLs, score, authority, summary and body", () => {
  const text = formatSearch(sample);
  for (const part of ["示例文章", "https://example.com/article", "Score: 2.4", "Authority: -1", "长摘要", "# 正文"]) assert(text.includes(part));
  assert.equal(formatSearch({ results: [] }), "No matching web results.");
});

test("small results expose complete structured responses", async () => {
  const result = await makeResult(sample, formatSearch(sample));
  assert.deepEqual(result.structuredContent.response, sample);
  assert.equal(result.structuredContent.truncated, false);
  assert(Value.Check(resultSchema(SearchResponse), result.structuredContent));
});

test("large UTF-8 single-line responses are bounded and saved in full", async () => {
  const page = { title: "Large", content: "你好😀".repeat(20_000) };
  const result = await makeResult(page, formatFetch("https://example.com", page));
  const file = result.structuredContent.fullOutputPath!;
  try {
    assert.equal(result.structuredContent.truncated, true);
    assert.equal(result.structuredContent.response, undefined);
    assert.equal((result.details as Record<string, unknown>).response, undefined);
    assert(Buffer.byteLength(result.content[0].text) < 50 * 1024);
    assert(result.content[0].text.includes(file));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), page);
    assert(Value.Check(resultSchema(FetchResponse), result.structuredContent));
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});

test("many lines trigger truncation even below byte limit", async () => {
  const page = { title: "Lines", content: "x\n".repeat(2100) };
  const result = await makeResult(page, formatFetch("https://example.com", page));
  try {
    assert.equal(result.structuredContent.truncated, true);
    assert(result.content[0].text.split("\n").length <= 2000);
  } finally { await rm(dirname(result.structuredContent.fullOutputPath!), { recursive: true, force: true }); }
});

test("hidden raw fields cannot bypass the structured response size limit", async () => {
  const data = structuredClone(sample);
  data.results[0].snippet = "x".repeat(60_000);
  const result = await makeResult(data, formatSearch(data));
  try {
    assert(result.structuredContent.truncated);
    assert.equal(result.structuredContent.response, undefined);
  } finally { await rm(dirname(result.structuredContent.fullOutputPath!), { recursive: true, force: true }); }
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
  const search = await tools[0].execute("search-test", { query: "hello", count: 1 }, signal, undefined, {} as never);
  assert(search.content[0].type === "text" && search.content[0].text.includes("长摘要"));
  const page = await tools[1].execute("fetch-test", { url: "https://example.com" }, signal, undefined, {} as never);
  assert(page.content[0].type === "text" && page.content[0].text.includes("# Markdown"));
  transport.mock.mockImplementation(async () => new Response(JSON.stringify({ results: "wrong" })));
  await assert.rejects(tools[0].execute("bad", { query: "hi" }, signal, undefined, {} as never), /unexpected response schema/);
});

test("package manifest exposes only the extension entrypoint and host peers", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.dependencies, undefined);
});
