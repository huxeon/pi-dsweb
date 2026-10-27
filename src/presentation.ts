import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SearchData } from "./schemas.ts";

export const FETCH_MAX_LINES = 2000;
export const FETCH_MAX_BYTES = 50 * 1024;

export interface SearchItemView {
  title: string;
  url: string;
  snippet: string;
}

/** Fetch UI receives the same body excerpt as the model, without wrappers.
 * Line counts mirror Pi's truncation details for the warning footer.
 */
export type FetchDetails = {
  title: string;
  content: string;
  totalLines: number;
  outputLines: number;
} & (
  | { truncated: false; truncatedBy?: never; fullOutputPath?: never }
  | { truncated: true; truncatedBy: "lines" | "bytes"; fullOutputPath: string }
);

/** Display-only sanitization; preserve Markdown line breaks and tabs. */
export function safeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Complete display-safe title/URL, without a character or byte cap. */
export function displayLine(text: string): string {
  return safeText(text).replace(/\s+/g, " ").trim();
}

/** Shared Fetch layout; callers control body normalization and line handling. */
export function formatFetchLines(title: string, bodyLines: readonly string[]): string[] {
  const heading = displayLine(title);
  return [...(heading ? [`Title: ${heading}`, ""] : []), ...bodyLines];
}

export function buildSearchItems(response: SearchData): SearchItemView[] {
  return response.results.map(item => ({
    title: displayLine(item.title || "Untitled result"),
    url: displayLine(item.url),
    // Short snippets are intended for UI; long summaries are for models.
    snippet: safeText(item.snippet),
  }));
}
