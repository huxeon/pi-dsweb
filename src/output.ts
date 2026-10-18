import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { FetchData, SearchData } from "./schemas.ts";

export function formatSearch(data: SearchData): string {
  if (!data.results.length) return "No matching web results.";
  return data.results.map((r, i) => [
    `## ${i + 1}. ${r.title}`,
    r.url,
    `Site: ${r.site_name ?? "unknown"} | Date: ${r.date ?? "unknown"} | Score: ${r.rerank_score} | Authority: ${r.authority}`,
    r.summary || r.snippet,
    ...(r.content ? ["### Page content", r.content] : []),
  ].join("\n\n")).join("\n\n");
}

export function formatFetch(url: string, data: FetchData): string {
  return [`# ${data.title || "Untitled page"}`, url, data.content || "(No page content returned.)"].join("\n\n");
}

export async function makeResult<T extends SearchData | FetchData>(response: T, text: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Reserve space for the truncation notice; also bound the structured response.
  const preview = truncateHead(text, { maxBytes: 48 * 1024, maxLines: 1900 });
  const json = JSON.stringify(response, null, 2);
  const truncated = preview.truncated || Buffer.byteLength(json, "utf8") > 48 * 1024 || json.split("\n").length > 1900;
  let fullOutputPath: string | undefined;
  let content = preview.content;
  if (truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-dsweb-"));
    fullOutputPath = join(dir, "response.json");
    await withFileMutationQueue(fullOutputPath, async () => {
      signal?.throwIfAborted();
      await writeFile(fullOutputPath!, json, { encoding: "utf8", mode: 0o600 });
    });
    content += `\n\n[Output truncated. Complete API response saved as JSON: ${fullOutputPath}. Use the read tool to inspect it.]`;
  }
  signal?.throwIfAborted();
  const structuredContent = {
    preview: content,
    truncated,
    ...(!truncated ? { response } : {}),
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent,
    details: { truncated, ...(fullOutputPath ? { fullOutputPath } : {}) },
  };
}
