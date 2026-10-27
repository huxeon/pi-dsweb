import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { request, validateFetch, validateSearch, type ClientOptions } from "../src/client.ts";

const env = { DEEPSEEK_API_KEY: "sk-test-secret" };
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const fake = (fn: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  ((url, init) => Promise.resolve(fn(String(url), init!))) as typeof fetch;

test("search uses the documented endpoint, auth and every optional field", async () => {
  const input = { query: 'DeepSeek site:github.com lang:zh after:2025', count: 5, ori_question: "用户问题", localization: "1.1.1.1", need_content: true };
  const result = await request("search", input, undefined, {
    env, fetch: fake((url, init) => {
      assert.equal(url, "https://api.deepseek.com/v1/tools/search");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer sk-test-secret");
      assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(init.body as string), input);
      return json({ results: [] });
    }),
  });
  assert.deepEqual(result, { results: [] });
});

test("omitted fields stay omitted; explicit null/false/empty localization are preserved", () => {
  assert.deepEqual(validateSearch({ query: "你好" }), { query: "你好" });
  const input = { query: "你好", need_content: false, ori_question: null, localization: "" };
  assert.deepEqual(validateSearch(input), input);
  assert.deepEqual(validateSearch({ query: "hi", extra: "ignore" } as never), { query: "hi" });
});

test("query counts Unicode code points rather than UTF-16 units", () => {
  assert.doesNotThrow(() => validateSearch({ query: "😀".repeat(128) }));
  assert.throws(() => validateSearch({ query: "😀".repeat(129) }), /Unicode/);
});

test("validates query, original question, count and optional types", () => {
  for (const query of ["", " \t\n", "a".repeat(129)]) assert.throws(() => validateSearch({ query }));
  for (const count of [0, 51, 1.5, NaN]) assert.throws(() => validateSearch({ query: "hi", count }));
  for (const ori_question of ["", "a".repeat(129)]) assert.throws(() => validateSearch({ query: "hi", ori_question }));
  assert.deepEqual(validateSearch({ query: "hi", ori_question: " " }), { query: "hi", ori_question: " " });
  assert.throws(() => validateSearch({ query: "hi", need_content: "false" } as never));
  assert.throws(() => validateSearch({ query: "hi", localization: null } as never));
});

test("fetch forwards only the URL, preserving query and fragment", async () => {
  const url = "https://example.com/article?q=a%20b#section";
  await request("fetch", { url }, undefined, { env, fetch: fake((endpoint, init) => {
    assert.equal(endpoint, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(JSON.parse(init.body as string), { url });
    return json({ title: "Article", content: "# Article" });
  }) });
});

test("rejects invalid fetch URLs and embedded credentials", () => {
  for (const url of ["", "example.com", "ftp://example.com", "file:///tmp/a", "https://u:p@example.com", "https://u@example.com", "https://", "https:example.com", "https:/example.com", "https:///example.com", "https://?q=example.com", "https://#example.com", "https://example.com\\path", "https://exa\nmple.com", " https://example.com", "https://example.com/" + "a".repeat(8192)]) {
    assert.throws(() => validateFetch({ url }), { name: "Error" }, url);
  }
  assert.deepEqual(validateFetch({ url: "http://example.com/" }), { url: "http://example.com/" });
});

test("missing API key fails before network access", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, { env: {}, fetch: fake(() => { throw new Error("must not fetch"); }) }), /Set DEEPSEEK_API_KEY/);
});

test("retries transient HTTP statuses with client backoff, ignoring Retry-After", async () => {
  for (const status of [408, 429, 500, 504]) {
    let calls = 0;
    const waits: number[] = [];
    const result = await request("search", { query: "hi" }, undefined, {
      env,
      fetch: fake(() => ++calls < 3 ? json({ error: { message: "retry" } }, status, { "Retry-After": "1000" }) : json({ results: [] })),
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepEqual(result, { results: [] });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test("uses exponential backoff capped at eight seconds", async () => {
  let calls = 0;
  const waits: number[] = [];
  await request("search", { query: "hi" }, undefined, {
    env: { ...env, DSWEB_MAX_RETRIES: "5" },
    fetch: fake(() => ++calls < 6 ? json({}, 429) : json({ results: [] })),
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(calls, 6);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000]);
});

test("does not retry non-transient errors and provides useful hints", async () => {
  for (const [status, hint] of [[400, "parameters"], [401, "DEEPSEEK_API_KEY"], [402, "balance"], [403, "security"], [404, "usable page"], [413, "large"]] as const) {
    let calls = 0;
    await assert.rejects(request("fetch", { url: "https://example.com" }, undefined, { env, fetch: fake(() => { calls++; return json({ error: { message: "bad request" } }, status); }) }), new RegExp(`HTTP ${status}.*${hint}`));
    assert.equal(calls, 1);
  }
});

test("retry budget is finite and zero disables retries", async () => {
  for (const max of [0, 2]) {
    let calls = 0;
    await assert.rejects(request("search", { query: "hi" }, undefined, {
      env: { ...env, DSWEB_MAX_RETRIES: String(max) },
      fetch: fake(() => { calls++; return json({}, 500); }), sleep: async () => {},
    }), /HTTP 500/);
    assert.equal(calls, max + 1);
  }
});

test("API errors redact credentials and do not expose arbitrary HTML", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, { env, fetch: fake(() => json({ error: { message: "sk-test-secret Bearer other-secret" } }, 401)) }), (err: Error) => {
    assert(!err.message.includes("sk-test-secret"));
    assert(!err.message.includes("other-secret"));
    return true;
  });
  await assert.rejects(request("search", { query: "hi" }, undefined, { env, fetch: fake(() => new Response("<html>sensitive proxy page</html>", { status: 400 })) }), (err: Error) => !err.message.includes("sensitive proxy"));
});

test("invalid JSON is an error, not a successful empty result", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, { env, fetch: fake(() => new Response("not json")) }), /invalid JSON/);
});

test("ambiguous network errors are not retried or leaked", async () => {
  let calls = 0;
  await assert.rejects(request("search", { query: "hi" }, undefined, { env, fetch: fake(() => { calls++; throw new Error("sk-test-secret"); }) }), /network request failed/);
  assert.equal(calls, 1);
});

test("validates timeout and retry configuration", async () => {
  for (const [name, value] of [["DSWEB_TIMEOUT_MS", "0"], ["DSWEB_TIMEOUT_MS", "NaN"], ["DSWEB_MAX_RETRIES", "6"], ["DSWEB_MAX_RETRIES", "1.5"]]) {
    await assert.rejects(request("search", { query: "hi" }, undefined, { env: { ...env, [name]: value } }), /integer/);
  }
});

test("pre-aborted calls never access network", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(request("search", { query: "hi" }, controller.signal, { env, fetch: fake(() => { throw new Error("must not fetch"); }) }), /cancelled/);
});

test("cancellation interrupts an in-flight request", async () => {
  const controller = new AbortController();
  const options: ClientOptions = { env, fetch: fake(async (_url, init) => {
    controller.abort(new Error("user cancelled"));
    await delay(1000, undefined, { signal: init.signal! });
    return json({});
  }) };
  await assert.rejects(request("search", { query: "hi" }, controller.signal, options), /user cancelled/);
});

test("total timeout covers in-flight fetch", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, {
    env: { ...env, DSWEB_TIMEOUT_MS: "5" }, fetch: fake(async (_url, init) => {
      await delay(1000, undefined, { signal: init.signal! }); return json({});
    }),
  }), /timed out after 5 ms/);
});

test("cancellation interrupts retry backoff", async () => {
  const controller = new AbortController();
  await assert.rejects(request("search", { query: "hi" }, controller.signal, {
    env, fetch: fake(() => json({}, 429)), sleep: async (_ms, signal) => {
      controller.abort(new Error("stop retrying"));
      signal.throwIfAborted();
    },
  }), /stop retrying/);
});
