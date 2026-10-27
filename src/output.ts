import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { FetchData, SearchData } from "./schemas.ts";
import { buildSearchItems, displayLine, FETCH_MAX_BYTES, FETCH_MAX_LINES, formatFetchLines, type FetchDetails } from "./presentation.ts";

/** Headings and metadata are single-line fields: collapsed whitespace keeps an
 * embedded newline from injecting extra Markdown structure into model text.
 */
export function formatSearch(data: SearchData, bodyPaths: ReadonlyMap<number, string> = new Map()): string {
  if (!data.results.length) return "No matching web results.";
  return data.results.map((r, i) => [
    `## ${i + 1}. ${displayLine(r.title) || "Untitled result"}`,
    displayLine(r.url),
    `Site: ${displayLine(r.site_name ?? "") || "unknown"} | Date: ${displayLine(r.date ?? "") || "unknown"} | Score: ${r.rerank_score} | Authority: ${r.authority}`,
    r.summary,
    ...(bodyPaths.has(i) ? [`Page content file: ${bodyPaths.get(i)}. Use the read tool to inspect it.`] : []),
  ].join("\n\n")).join("\n\n");
}

export function formatFetch(data: FetchData): string {
  return formatFetchLines(data.title, data.content.split("\n")).join("\n");
}

/** Search summaries are untruncated; page bodies live in separate Markdown files.
 * Codemode receives exactly the original API response, with no wrapper.
 */
export async function makeSearchResult(response: SearchData, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bodyPaths = new Map<number, string>();
  let contentDirectory: string | undefined;
  try {
    for (const [index, item] of response.results.entries()) {
      if (!item.content) continue;
      signal?.throwIfAborted();
      contentDirectory ??= await mkdtemp(join(tmpdir(), "pi-dsweb-search-"));
      const path = join(contentDirectory, `result-${index + 1}.md`);
      signal?.throwIfAborted();
      await writeFile(path, item.content, { encoding: "utf8", mode: 0o600, signal });
      bodyPaths.set(index, path);
    }
    signal?.throwIfAborted();
    return {
      content: [{ type: "text" as const, text: formatSearch(response, bodyPaths) }],
      structuredContent: response,
      // Pi passes content/details, but not structuredContent, to renderResult.
      details: buildSearchItems(response),
    };
  } catch (error) {
    if (contentDirectory) await rm(contentDirectory, { recursive: true, force: true }).catch(() => {});
    signal?.throwIfAborted();
    throw error;
  }
}

/** Keep complete lines where possible, but retain a UTF-8-safe first-line prefix. */
function fetchPreview(body: string) {
  const truncation = truncateHead(body, { maxBytes: FETCH_MAX_BYTES, maxLines: FETCH_MAX_LINES });
  const content = truncation.firstLineExceedsLimit
    ? new TextDecoder().decode(Buffer.from(body, "utf8").subarray(0, FETCH_MAX_BYTES), { stream: true })
    : truncation.content;
  return { truncation, content };
}

/** Fetch exposes the raw response to codemode; only the displayed body is bounded. */
export async function makeFetchResult(response: FetchData, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { truncation: preview, content: excerpt } = fetchPreview(response.content);
  let content = formatFetch({ title: response.title, content: excerpt });
  const base = {
    title: displayLine(response.title),
    content: excerpt,
    totalLines: preview.totalLines,
    outputLines: preview.firstLineExceedsLimit ? 1 : preview.outputLines,
  };
  let details: FetchDetails = { ...base, truncated: false };
  let ownedPath: string | undefined;
  try {
    if (preview.truncated) {
      const path = join(tmpdir(), `pi-dsweb-fetch-${randomBytes(8).toString("hex")}.md`);
      signal?.throwIfAborted();
      const file = await open(path, "wx", 0o600);
      ownedPath = path;
      try {
        await file.writeFile(response.content, { encoding: "utf8", signal });
      } finally {
        await file.close();
      }
      if (preview.firstLineExceedsLimit) {
        const firstLine = response.content.split("\n", 1)[0];
        content += `\n\n[Showing first ${formatSize(Buffer.byteLength(excerpt))} of line 1 (line is ${formatSize(Buffer.byteLength(firstLine))}). Full output: ${path}]`;
      } else {
        const limit = preview.truncatedBy === "bytes" ? ` (${formatSize(FETCH_MAX_BYTES)} limit)` : "";
        content += `\n\n[Showing lines 1-${preview.outputLines} of ${preview.totalLines}${limit}. Full output: ${path}]`;
      }
      if (!preview.truncatedBy) throw new Error("Missing fetch truncation reason.");
      details = { ...base, truncated: true, truncatedBy: preview.truncatedBy, fullOutputPath: path };
    }
    signal?.throwIfAborted();
    return {
      content: [{ type: "text" as const, text: content }],
      structuredContent: response,
      details,
    };
  } catch (error) {
    if (ownedPath) await rm(ownedPath, { force: true }).catch(() => {});
    signal?.throwIfAborted();
    throw error;
  }
}
