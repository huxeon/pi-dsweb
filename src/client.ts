import { setTimeout as sleep } from "node:timers/promises";
import type { FetchInput, SearchInput } from "./schemas.ts";

const ROOT = "https://api.deepseek.com/v1/tools/";
const hints: Record<number, string> = {
  400: "Check request parameters.",
  401: "Check DEEPSEEK_API_KEY or the DeepSeek credential configured in Pi.",
  402: "Insufficient balance; top up your DeepSeek account before retrying.",
  403: "DeepSeek's fetch security policy rejected the URL.",
  404: "No usable page content; the site may block access or use an unsupported format.",
  408: "Timed out while reading the request body; try again later.",
  413: "Request body is too large.",
  429: "Rate limited (account or target domain); try again later.",
};

export interface ClientOptions {
  env?: NodeJS.ProcessEnv;
  // Resolve Pi's deepseek credential lazily; the environment takes precedence.
  resolveApiKey?: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  // Injection point for deterministic, offline retry tests.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function validateQuestion(value: unknown, name: string, rejectWhitespace = false) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 128 || (rejectWhitespace && !value.trim())) {
    throw new Error(`${name} must contain 1–128 Unicode characters${rejectWhitespace ? " and not be whitespace-only" : ""}.`);
  }
}

export function validateSearch(input: SearchInput): SearchInput {
  validateQuestion(input.query, "query", true);
  if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)) {
    throw new Error("count must be an integer between 1 and 50.");
  }
  if (input.ori_question != null) validateQuestion(input.ori_question, "ori_question");
  if (input.localization !== undefined && typeof input.localization !== "string") throw new Error("localization must be a string.");
  if (input.need_content !== undefined && typeof input.need_content !== "boolean") throw new Error("need_content must be a boolean.");
  // Only forward documented fields, including explicit false and null values.
  return {
    query: input.query,
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.ori_question !== undefined ? { ori_question: input.ori_question } : {}),
    ...(input.localization !== undefined ? { localization: input.localization } : {}),
    ...(input.need_content !== undefined ? { need_content: input.need_content } : {}),
  };
}

export function validateFetch(input: FetchInput): FetchInput {
  if (typeof input.url !== "string" || !input.url || [...input.url].length > 8192 || input.url !== input.url.trim()) {
    throw new Error("url must be a valid HTTP(S) URL of at most 8192 characters, without surrounding whitespace.");
  }
  // WHATWG URL parsing repairs missing authority/slashes and treats backslashes
  // as slashes. Do not silently accept a different URL than the API receives.
  if (!/^https?:\/\/[^/?#\\\s]+/i.test(input.url) || /[\\\u0000-\u001f\u007f]/.test(input.url)) {
    throw new Error("url must be a valid HTTP(S) URL with an explicit host and no backslashes or control characters.");
  }
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { throw new Error("url must be a valid HTTP(S) URL."); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("url must use HTTP(S), have a host, and contain no username or password.");
  }
  return { url: input.url };
}

function redact(message: string, key: string) {
  return message.split(key).join("[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function errorMessage(body: string, key: string) {
  try {
    const data = JSON.parse(body);
    if (typeof data?.error?.message === "string") return redact(data.error.message, key).slice(0, 1000);
  } catch { /* Do not expose HTML proxy errors or arbitrary response bodies. */ }
  return "The API returned an error without a JSON error message.";
}

function retryDelay(header: string | null, attempt: number) {
  const seconds = header === null ? NaN : Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.min(30_000, Math.max(0, delay)) : Math.min(8000, 1000 * 2 ** attempt);
}

/** No network, timers or credential access occurs until a tool is executed. */
export async function request(operation: "search" | "fetch", input: SearchInput | FetchInput, signal?: AbortSignal, options: ClientOptions = {}): Promise<unknown> {
  const body = operation === "search" ? validateSearch(input as SearchInput) : validateFetch(input as FetchInput);
  const env = options.env ?? process.env;
  signal?.throwIfAborted();
  let key = env.DEEPSEEK_API_KEY?.trim();
  if (!key && options.resolveApiKey) {
    try { key = (await options.resolveApiKey())?.trim(); }
    catch {
      signal?.throwIfAborted();
      throw new Error("Could not resolve Pi's DeepSeek credential. Configure DeepSeek with /login or set DEEPSEEK_API_KEY.");
    }
  }
  signal?.throwIfAborted();
  if (!key) throw new Error("Set DEEPSEEK_API_KEY before starting Pi, or configure the deepseek provider in Pi with /login. This extension does not load .env.");
  const timeout = integerSetting(env, "DSWEB_TIMEOUT_MS", 60_000, 1, 600_000);
  const retries = integerSetting(env, "DSWEB_MAX_RETRIES", 2, 0, 5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`DeepSeek ${operation} timed out after ${timeout} ms.`)), timeout);
  timer.unref();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const fetcher = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? ((ms, s) => sleep(ms, undefined, { signal: s }));
  try {
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted();
      let response: Response;
      try {
        response = await fetcher(ROOT + operation, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body), signal: combined,
          // Never forward the credential to a redirect target.
          redirect: "error",
        });
      } catch {
        combined.throwIfAborted();
        // An ambiguous network failure may have reached the server: do not
        // automatically repeat a potentially billable successful request.
        throw new Error(`DeepSeek ${operation} network request failed. Check connectivity and retry manually.`);
      }
      let text: string;
      try { text = await response.text(); }
      catch {
        combined.throwIfAborted();
        throw new Error(`DeepSeek ${operation} response body could not be read. Retry manually.`);
      }
      combined.throwIfAborted();
      if (response.status !== 200) {
        const serverError = response.status >= 500 && response.status <= 599;
        if ((response.status === 408 || response.status === 429 || serverError) && attempt < retries) {
          await wait(retryDelay(response.headers.get("retry-after"), attempt), combined);
          continue;
        }
        throw new Error(`DeepSeek ${operation}: HTTP ${response.status}. ${errorMessage(text, key)} ${hints[response.status] ?? (serverError ? "Service error; try again later." : "Unexpected HTTP status.")}`.trim());
      }
      try { return JSON.parse(text) as unknown; }
      catch { throw new Error(`DeepSeek ${operation} returned invalid JSON.`); }
    }
  } catch (error) {
    combined.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
