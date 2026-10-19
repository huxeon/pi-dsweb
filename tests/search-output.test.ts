import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { makeSearchResult, searchBodyPaths } from "./helpers.ts";
import { buildSearchItems } from "../src/presentation.ts";
import type { SearchData } from "../src/schemas.ts";

function item(index: number, content = "") {
  return {
    title: `Article ${index}`, url: `https://example.com/${index}`, rerank_score: 2,
    snippet: `Snippet ${index}`, summary: `Summary ${index}`, content,
    site_name: null, site_icon: null, date: null, authority: 3,
  };
}

async function isolatedTemp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-dsweb-search-test-"));
  const names = ["TMPDIR", "TMP", "TEMP"];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => { process.env[name] = root; });
  t.after(async () => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("search saves each nonempty page body as exact Markdown and tells the model its path", async () => {
  const data: SearchData = { results: [item(1, "# 正文\n\nHello 😀\u001b[31m"), item(2), item(3, "Second page\n")] };
  const original = structuredClone(data);
  const result = await makeSearchResult(data);
  const directory = dirname(searchBodyPaths(result)[0]);
  assert.deepEqual((await readdir(directory)).sort(), ["result-1.md", "result-3.md"]);
  const text = result.content[0].text;
  for (const index of [0, 2]) {
    const path = join(directory, `result-${index + 1}.md`);
    assert.equal(await readFile(path, "utf8"), data.results[index].content);
    assert(text.includes(path));
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert(text.includes("Use the read tool to inspect it"));
  assert(!text.includes("# 正文"));
  assert(!text.includes("Second page"));
  assert(!text.includes("Snippet 1"));
  assert.equal(result.structuredContent, data);
  assert.deepEqual(data, original);
  assert(Array.isArray(result.details));
});

test("search never falls back to snippet when summary is empty", async () => {
  const data: SearchData = { results: [{ ...item(1), summary: "", snippet: "UI-only snippet" }] };
  const result = await makeSearchResult(data);
  assert(!result.content[0].text.includes("UI-only snippet"));
  assert.equal(result.structuredContent.results[0].snippet, "UI-only snippet");
  const items = buildSearchItems(result.structuredContent);
  assert.equal(items[0].snippet, "UI-only snippet");
});

test("large summaries and all results remain intact without byte or line truncation", async () => {
  const summary = "LONG SUMMARY " + "中".repeat(30_000) + "\nline".repeat(2100);
  const data = {
    results: [{ ...item(1, "BODY MUST NOT BE INLINE ".repeat(10_000)), summary }, item(2)],
    extra_api_field: { preserved: true },
  };
  const result = await makeSearchResult(data);
  const text = result.content[0].text;
  assert(Buffer.byteLength(text) > 48 * 1024);
  assert(text.split("\n").length > 1900);
  assert(text.includes(summary));
  assert(text.includes("Summary 2"));
  assert(!text.includes("BODY MUST NOT BE INLINE"));
  assert(!text.includes("Output truncated"));
  assert(Array.isArray(result.details));
  assert.equal(result.structuredContent, data);
  assert(!("preview" in result.structuredContent));
  assert(!("truncated" in result.structuredContent));
  assert(!("response" in result.structuredContent));
  assert(!("fullOutputPath" in result.structuredContent));
});

test("empty search and results without page bodies do not create temporary files", async (t) => {
  const root = await isolatedTemp(t);
  const empty = await makeSearchResult({ results: [] });
  assert.equal(empty.content[0].text, "No matching web results.");
  assert.deepEqual(empty.structuredContent, { results: [] });
  const small = await makeSearchResult({ results: [item(1)] });
  assert(Array.isArray(small.details));
  assert(!small.content[0].text.includes("Page content file"));
  assert.deepEqual(await readdir(root), []);
});

test("search requests use distinct temporary directories", async () => {
  const data = { results: [item(1, "body")] };
  const [first, second] = await Promise.all([makeSearchResult(data), makeSearchResult(data)]);
  const firstPath = searchBodyPaths(first)[0];
  const secondPath = searchBodyPaths(second)[0];
  assert.notEqual(dirname(firstPath), dirname(secondPath));
  assert.equal(await readFile(firstPath, "utf8"), "body");
  assert.equal(await readFile(secondPath, "utf8"), "body");
});

test("cancellation cleans partially written page bodies and pre-aborted calls write nothing", async (t) => {
  const root = await isolatedTemp(t);
  const data = { results: [item(1, "first body"), item(2, "second body")] };
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(makeSearchResult(data, preAborted.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(root), []);
  const controller = new AbortController();
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, "throwIfAborted", () => {
    if (++checks === 4) controller.abort(); // First file written; second not started.
    original();
  });
  await assert.rejects(makeSearchResult(data, controller.signal), { name: "AbortError" });
  assert(checks >= 4);
  assert.deepEqual(await readdir(root), []);
});

test("failure to save requested page bodies is an error, not a nonexistent path", async (t) => {
  const root = await isolatedTemp(t);
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "test");
  ["TMPDIR", "TMP", "TEMP"].forEach(name => { process.env[name] = blocker; });
  await assert.rejects(makeSearchResult({ results: [item(1, "body")] }));
  const withoutBody = await makeSearchResult({ results: [item(1)] });
  assert(Array.isArray(withoutBody.details));
});
