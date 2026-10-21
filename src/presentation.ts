import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SearchData } from "./schemas.ts";

export interface SearchItemView {
  title: string;
  domain: string;
  url: string;
  snippet: string;
}

/** Fetch UI receives the same body excerpt as the model, without wrappers.
 * Line counts mirror Pi's truncation details for the warning footer.
 */
export interface FetchDetails {
  title: string;
  bytes: number;
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

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

export function singleLine(text: string, limit = 240): string {
  const clean = displayLine(text);
  const chars = [...clean];
  return chars.length > limit ? chars.slice(0, limit).join("") + "..." : clean;
}

export function domainOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? displayLine(parsed.hostname) : "unknown source";
  } catch { return "unknown source"; }
}

export function buildSearchItems(response: SearchData): SearchItemView[] {
  return response.results.map(item => ({
    title: displayLine(item.title || "Untitled result"),
    domain: domainOf(item.url),
    url: displayLine(item.url),
    // Short snippets are intended for UI; long summaries are for models.
    snippet: safeText(item.snippet),
  }));
}
