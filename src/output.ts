import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { FetchData, SearchData } from "./schemas.ts";
import { buildSearchItems, displayLine, formatFetchLines, type FetchDetails } from "./presentation.ts";

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
      await withFileMutationQueue(path, async () => {
        signal?.throwIfAborted();
        await writeFile(path, item.content, { encoding: "utf8", mode: 0o600, signal });
      });
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

/** Fetch exposes the raw response to codemode; only the displayed body is bounded. */
export async function makeFetchResult(response: FetchData, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const preview = truncateHead(response.content, { maxBytes: 48 * 1024, maxLines: 1900 });
  let content = formatFetch({ title: response.title, content: preview.content });
  let directory: string | undefined;
  try {
    if (preview.truncated) {
      directory = await mkdtemp(join(tmpdir(), "pi-dsweb-fetch-"));
      const path = join(directory, "content.md");
      await withFileMutationQueue(path, async () => {
        signal?.throwIfAborted();
        await writeFile(path, response.content, { encoding: "utf8", mode: 0o600, signal });
      });
      content += `\n\n[Content truncated. Complete page content saved as Markdown: ${path}. Use the read tool to inspect it.]`;
    }
    signal?.throwIfAborted();
    const details: FetchDetails = {
      title: displayLine(response.title),
      bytes: Buffer.byteLength(response.content, "utf8"),
      content: preview.content,
      truncated: preview.truncated,
      totalLines: preview.totalLines,
      outputLines: preview.outputLines,
    };
    return {
      content: [{ type: "text" as const, text: content }],
      structuredContent: response,
      details,
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    signal?.throwIfAborted();
    throw error;
  }
}
