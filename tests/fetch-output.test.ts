import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { formatFetch } from "../src/output.ts";
import { fetchBodyPaths, makeFetchResult } from "./helpers.ts";

async function isolatedTemp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-dsweb-fetch-test-"));
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

test("small fetch text contains title/body, with raw codemode output and flat UI details", async (t) => {
  const root = await isolatedTemp(t);
  const page = { title: "Page title", content: "## Heading\n\n正文 😀" };
  const original = structuredClone(page);
  const result = await makeFetchResult(page);
  assert.equal(result.content[0].text, formatFetch(page));
  assert.equal(result.content[0].text, "# Page title\n\n## Heading\n\n正文 😀");
  assert.equal(result.structuredContent, page);
  assert.deepEqual(result.details, {
    title: page.title, bytes: Buffer.byteLength(page.content), content: page.content, truncated: false,
  });
  assert.deepEqual(page, original);
  assert.deepEqual(await readdir(root), []);
});

test("empty fetch keeps the raw response and shows a clear empty state without files", async (t) => {
  const root = await isolatedTemp(t);
  const page = { title: "", content: "" };
  const result = await makeFetchResult(page);
  assert.equal(result.content[0].text, "# Untitled page\n\n(No page content returned.)");
  assert.equal(result.structuredContent, page);
  assert.deepEqual(result.details, { title: "Untitled page", bytes: 0, content: "", truncated: false });
  assert.deepEqual(await readdir(root), []);
});

test("fetch byte limit applies to body, not JSON size or escaping", async () => {
  const exact = { title: "Page", content: "x".repeat(48 * 1024) };
  const small = await makeFetchResult(exact);
  assert.equal(small.details.truncated, false);
  assert.equal(small.details.content, exact.content);
  assert.deepEqual(fetchBodyPaths(small), []);
  const oversized = { ...exact, content: exact.content + "x" };
  const large = await makeFetchResult(oversized);
  assert.equal(large.details.truncated, true);
  assert(Buffer.byteLength(large.details.content) <= 48 * 1024);
  assert.equal(large.structuredContent, oversized);
  const escaped = { title: "Page", content: '"\\'.repeat(15_000), extra: "x".repeat(100_000) };
  const raw = await makeFetchResult(escaped);
  assert.equal(raw.details.truncated, false);
  assert.equal(raw.structuredContent, escaped);
  assert.deepEqual(fetchBodyPaths(raw), []);
});

test("fetch line limit preserves 1900 lines and truncates longer bodies only once", async () => {
  const exact = { title: "Page", content: Array.from({ length: 1900 }, (_, i) => `Line ${i}`).join("\n") };
  const result = await makeFetchResult(exact);
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.content, exact.content);
  const long = { ...exact, content: exact.content + "\nNOT IN PREVIEW" };
  const truncated = await makeFetchResult(long);
  assert(truncated.details.truncated);
  assert.equal(truncated.details.content, exact.content);
  assert(truncated.content[0].text.includes(exact.content));
  assert(!truncated.content[0].text.includes("NOT IN PREVIEW"));
  assert.equal(truncated.structuredContent, long);
});

test("truncated fetch saves the exact complete UTF-8 body as private Markdown", async () => {
  const page = { title: "Large UTF-8", content: "你好😀\n".repeat(8000) + "COMPLETE END" };
  const original = structuredClone(page);
  const result = await makeFetchResult(page);
  const paths = fetchBodyPaths(result);
  assert.equal(paths.length, 1);
  assert(paths[0].endsWith("content.md"));
  assert.equal(await readFile(paths[0], "utf8"), page.content);
  if (process.platform !== "win32") assert.equal((await stat(paths[0])).mode & 0o777, 0o600);
  assert(page.content.startsWith(result.details.content));
  assert(!result.details.content.includes("�"));
  assert(!result.details.content.includes("COMPLETE END"));
  assert(result.content[0].text.includes(result.details.content));
  assert(!result.content[0].text.includes("COMPLETE END"));
  assert(!JSON.stringify(result.details).includes(paths[0]));
  assert.equal(result.details.bytes, Buffer.byteLength(page.content));
  assert.equal(result.structuredContent, page);
  assert.deepEqual(page, original);
});

test("cancelled fetch output leaves no temporary files, including cancellation after a write", async (t) => {
  const root = await isolatedTemp(t);
  const page = { title: "Page", content: "x".repeat(60_000) };
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(makeFetchResult(page, preAborted.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(root), []);
  const controller = new AbortController();
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, "throwIfAborted", () => {
    if (++checks === 3) controller.abort();
    original();
  });
  await assert.rejects(makeFetchResult(page, controller.signal), { name: "AbortError" });
  assert(checks >= 3);
  assert.deepEqual(await readdir(root), []);
});

test("separate truncated fetch calls never overwrite one another's files", async () => {
  const firstPage = { title: "First", content: "a".repeat(60_000) };
  const secondPage = { title: "Second", content: "b".repeat(60_000) };
  const [first, second] = await Promise.all([makeFetchResult(firstPage), makeFetchResult(secondPage)]);
  const firstPath = fetchBodyPaths(first)[0];
  const secondPath = fetchBodyPaths(second)[0];
  assert.notEqual(firstPath, secondPath);
  assert.equal(await readFile(firstPath, "utf8"), firstPage.content);
  assert.equal(await readFile(secondPath, "utf8"), secondPage.content);
});
