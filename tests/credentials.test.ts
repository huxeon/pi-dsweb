import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { request } from "../src/client.ts";
import { trackResult } from "./helpers.ts";

test("environment key takes precedence without invoking Pi's resolver", async () => {
  await request("search", { query: "hi" }, undefined, {
    env: { DEEPSEEK_API_KEY: " env-key " },
    resolveApiKey: async () => { throw new Error("must not resolve"); },
    fetch: async (_url, init) => {
      assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer env-key");
      return new Response('{"results":[]}');
    },
  });
});

test("missing or whitespace-only environment key falls back to Pi", async () => {
  for (const value of [undefined, "", "   "]) {
    let calls = 0;
    await request("fetch", { url: "https://example.com" }, undefined, {
      env: { DEEPSEEK_API_KEY: value },
      resolveApiKey: async () => { calls++; return " saved-key "; },
      fetch: async (_url, init) => {
        assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer saved-key");
        return new Response('{"title":"","content":"body"}');
      },
    });
    assert.equal(calls, 1);
  }
});

test("missing credentials prompt Pi login before any network access", async () => {
  for (const key of [undefined, "", " "]) {
    await assert.rejects(request("search", { query: "hi" }, undefined, {
      env: {},
      resolveApiKey: async () => key,
      fetch: async () => { throw new Error("must not fetch"); },
    }), /Set DEEPSEEK_API_KEY.*deepseek.*\/login/);
  }
});

test("resolver failures cannot expose credentials", async () => {
  await assert.rejects(request("search", { query: "hi" }, undefined, {
    env: {},
    resolveApiKey: async () => { throw new Error("secret-from-store"); },
  }), (error: Error) => error.message.includes("Could not resolve") && !error.message.includes("secret-from-store"));
});

test("aborted calls do not resolve credentials", async () => {
  await assert.rejects(request("search", { query: "hi" }, AbortSignal.abort(new Error("cancelled")), {
    env: {},
    resolveApiKey: async () => { throw new Error("must not resolve"); },
  }), /cancelled/);
});

test("both registered tools resolve only deepseek credentials on every execution", async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });
  const tools: ToolDefinition[] = [];
  extension({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
  let calls = 0;
  const ctx = {
    model: { provider: "another-provider" },
    modelRegistry: {
      getApiKeyForProvider: async (provider: string) => {
        assert.equal(provider, "deepseek");
        return `saved-key-${++calls}`;
      },
    },
  };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer saved-key-${calls}`);
    return new Response(JSON.stringify(calls === 1 ? { results: [] } : { title: "Article", content: "# Body" }));
  });
  const signal = new AbortController().signal;
  trackResult(await tools[0].execute("search", { query: "hi" }, signal, undefined, ctx as never));
  trackResult(await tools[1].execute("fetch", { url: "https://example.com" }, signal, undefined, ctx as never));
  assert.equal(calls, 2);
});
