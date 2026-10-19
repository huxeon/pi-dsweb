import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SearchData } from "./schemas.ts";

export interface SearchItemView {
  title: string;
  domain: string;
  url: string;
  snippet: string;
}

/** Fetch UI receives the same body excerpt as the model, without wrappers. */
export interface FetchDetails {
  title: string;
  bytes: number;
  content: string;
  truncated: boolean;
}

/** Display-only sanitization; preserve Markdown line breaks and tabs. */
export function safeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function singleLine(text: string, limit = 240): string {
  const clean = safeText(text).replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > limit ? chars.slice(0, limit).join("") + "..." : clean;
}

/** Bound serialized field size, including UTF-8 and JSON escaping. */
function boundedLine(text: string, maxBytes: number): string {
  const clean = safeText(text).replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(JSON.stringify(clean), "utf8") <= maxBytes) return clean;
  let bytes = 5; // JSON quotes and three ASCII dots.
  let output = "";
  for (const char of clean) {
    const size = Buffer.byteLength(JSON.stringify(char), "utf8") - 2;
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output + "...";
}

export function domainOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? singleLine(parsed.hostname, 100) : "unknown source";
  } catch { return "unknown source"; }
}

export function buildSearchItems(response: SearchData): SearchItemView[] {
  return response.results.map(item => ({
    title: boundedLine(item.title || "Untitled result", 96),
    domain: boundedLine(domainOf(item.url), 64),
    url: boundedLine(item.url, 144),
    // Short snippets are intended for UI; long summaries are for models.
    snippet: boundedLine(item.snippet, 96),
  }));
}
