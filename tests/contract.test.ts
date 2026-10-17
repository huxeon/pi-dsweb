import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { request, validateFetch, validateSearch } from "../src/client.ts";
import { SearchParams, SearchResponse } from "../src/schemas.ts";

const env = { DEEPSEEK_API_KEY: "sk-contract-test", DEEPSEEK_WEB_MAX_RETRIES: "0" };
const searchResult = {
  rerank_score: 2.4,
  title: "DeepSeek V4 model released",
  url: "https://example.com/deepseek-v4",
  snippet: "Short summary",
  summary: "Long summary",
  content: "",
  site_name: "Example News",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-06-01T00:00:00+00:00",
  authority: 3,
};

test("original question follows its own length/null contract without query's whitespace rule", () => {
  for (const ori_question of [null, " ", "😀".repeat(128)]) {
    const input = { query: "DeepSeek", ori_question };
    assert(Value.Check(SearchParams, input));
    assert.deepEqual(validateSearch(input), input);
  }
  assert.throws(() => validateSearch({ query: "DeepSeek", ori_question: "😀".repeat(129) }));
  assert.throws(() => validateSearch({ query: " " }));
  assert(!Value.Check(SearchParams, { query: " \t\n" }));
});

test("search score and authority match the documented bounds", () => {
  for (const rerank_score of [0, 1.5, 3]) {
    for (const authority of [-1, 0, 4]) {
      assert(Value.Check(SearchResponse, { results: [{ ...searchResult, rerank_score, authority }] }));
    }
  }
  for (const rerank_score of [-0.1, 3.1]) {
    assert(!Value.Check(SearchResponse, { results: [{ ...searchResult, rerank_score }] }));
  }
  for (const authority of [-2, 5, 1.5]) {
    assert(!Value.Check(SearchResponse, { results: [{ ...searchResult, authority }] }));
  }
});

test("publication date is nullable RFC 3339, not an arbitrary string", () => {
  for (const date of [null, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00+00:00"]) {
    assert(Value.Check(SearchResponse, { results: [{ ...searchResult, date }] }));
  }
  for (const date of ["", "yesterday", "2026-06-01"]) {
    assert(!Value.Check(SearchResponse, { results: [{ ...searchResult, date }] }));
  }
});

test("fetch supports valid IPv6, international domains, and the 8192-character boundary", () => {
  const prefix = "https://example.com/";
  for (const url of ["https://[::1]/", "https://例子.测试/文章", prefix + "a".repeat(8192 - prefix.length)]) {
    assert.deepEqual(validateFetch({ url }), { url });
  }
  assert.throws(() => validateFetch({ url: prefix + "a".repeat(8193 - prefix.length) }));
});

test("only HTTP 200 is treated as success; unexpected 2xx are not retried", async () => {
  for (const status of [201, 202, 206]) {
    let calls = 0;
    await assert.rejects(request("search", { query: "hi" }, undefined, {
      env,
      fetch: async () => {
        calls++;
        return new Response('{"results":[]}', { status });
      },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test("nonstandard 600 status is not mistaken for a retryable 5xx", async () => {
  let calls = 0;
  await assert.rejects(request("search", { query: "hi" }, undefined, {
    env: { ...env, DEEPSEEK_WEB_MAX_RETRIES: "2" },
    fetch: async () => {
      calls++;
      return { status: 600, text: async () => "{}", headers: new Headers() } as Response;
    },
    sleep: async () => { throw new Error("must not retry"); },
  }), /HTTP 600/);
  assert.equal(calls, 1);
});

test("response-body transport errors are sanitized and not retried", async () => {
  let calls = 0;
  await assert.rejects(request("search", { query: "hi" }, undefined, {
    env,
    fetch: async () => {
      calls++;
      const response = new Response();
      response.text = async () => { throw new Error("sk-contract-test"); };
      return response;
    },
  }), (error: Error) => error.message.includes("response body could not be read") && !error.message.includes("sk-contract-test"));
  assert.equal(calls, 1);
});

test("408 error explains the documented request-body timeout", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, {
    env,
    fetch: async () => new Response('{"error":{"message":"timeout","param":null}}', { status: 408 }),
  }), /reading the request body/);
});
