import {
  formatSize, keyHint,
  type AgentToolResult, type Theme, type ToolDefinition, type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { FETCH_MAX_BYTES, formatFetchLines, safeText, type FetchDetails, type SearchItemView } from "./presentation.ts";
import type { FetchInput, SearchInput } from "./schemas.ts";
import { startToolTimer, toolTimerText } from "./timing.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type Operation = "search" | "fetch";

/** Visual output rows shown before the user expands. */
const RESULT_PREVIEW_LINES = 5;

/** Built-in call lines wrap naturally and guard the zero-width case. */
class CallText implements Component {
  private readonly text = new Text("", 0, 0);
  update(text: string) { this.text.setText(text); }
  invalidate() { this.text.invalidate(); }
  render(width: number): string[] {
    // A wide Unicode glyph cannot fit a one-column viewport; avoid overflow
    // without introducing an ellipsis or resetting styles on ordinary rows.
    return width <= 0 ? [] : this.text.render(width).map(line => truncateToWidth(line, width, ""));
  }
}

function callText(context: RenderContext, text: string): Component {
  const component = context.lastComponent instanceof CallText ? context.lastComponent : new CallText();
  component.update(text);
  return component;
}

function clip(line: string, width: number): string { return truncateToWidth(line, width, "..."); }

function mutedHint(theme: Theme, text: string, hint: string): string {
  // keyHint starts with the key name: keep a space after the leading text.
  return theme.fg("muted", text) + " " + keyHint("app.tools.expand", hint) + theme.fg("muted", ")");
}

export function renderSearchCall(args: Partial<SearchInput>, theme: Theme, context: RenderContext): Component {
  startToolTimer(context);
  const query = args.query ? safeText(args.query) : "";
  const flags = [
    args.count !== undefined ? `count ${args.count}` : "",
    args.need_content ? "content" : "",
  ].filter(Boolean);
  return callText(context,
    theme.fg("toolTitle", theme.bold("web_search")) + " " +
    (query ? theme.fg("accent", query) : theme.fg("muted", "...")) +
    (flags.length ? theme.fg("muted", ` (${flags.join(", ")})`) : ""),
  );
}

/** Built-in call lines keep the full argument and let Text wrap it. */
export function renderFetchCall(args: Partial<FetchInput>, theme: Theme, context: RenderContext): Component {
  startToolTimer(context);
  return callText(context, theme.fg("toolTitle", theme.bold("web_fetch")) + " " +
    (args.url ? theme.fg("accent", safeText(args.url)) : theme.fg("muted", "...")));
}

function fetchDetailsOf(value: unknown): FetchDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const details = value as Partial<FetchDetails>;
  if (typeof details.title !== "string" || typeof details.content !== "string" ||
      typeof details.totalLines !== "number" || typeof details.outputLines !== "number") return undefined;
  if (details.truncated === false) return details as FetchDetails;
  if (details.truncated === true && (details.truncatedBy === "lines" || details.truncatedBy === "bytes") &&
      typeof details.fullOutputPath === "string" && details.fullOutputPath.length > 0) return details as FetchDetails;
  return undefined;
}

/** One uniform output line per field, as Pi's built-in tools print raw output. */
function searchOutputLines(items: SearchItemView[]): string[] {
  const lines: string[] = [];
  items.forEach((item, index) => {
    if (index > 0) lines.push("");
    lines.push(`${index + 1}. ${item.title}`);
    if (item.url) lines.push(item.url);
    if (item.snippet) lines.push(...safeText(item.snippet).replace(/\t/g, "   ").split("\n"));
  });
  return lines;
}

function isSearchItem(value: unknown): value is SearchItemView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SearchItemView>;
  return typeof item.title === "string" && typeof item.url === "string" && typeof item.snippet === "string";
}

/** Validate persisted UI details as well as freshly generated tool output. */
function searchItemsOf(value: unknown): SearchItemView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // Array.from also checks sparse slots instead of silently skipping them.
  const items = Array.from(value);
  return items.every(isSearchItem) ? items : undefined;
}

function previewStyledLines(styled: readonly string[], expanded: boolean, theme: Theme, width: number): string[] {
  if (expanded) return [...styled];
  const rows = new Text(styled.join("\n"), 0, 0).render(width);
  const hidden = Math.max(0, rows.length - RESULT_PREVIEW_LINES);
  const lines = rows.slice(0, RESULT_PREVIEW_LINES);
  if (hidden > 0) lines.push(mutedHint(theme, `... (${hidden} more line${hidden === 1 ? "" : "s"},`, "to expand"));
  return lines;
}

function previewLines(all: readonly string[], expanded: boolean, theme: Theme, width: number): string[] {
  return previewStyledLines(all.map(line => theme.fg("toolOutput", line)), expanded, theme, width);
}

function formatSearch(details: unknown, expanded: boolean, theme: Theme, width: number): string {
  const items = searchItemsOf(details);
  if (!items) return "\n" + theme.fg("muted", "Search preview unavailable.");
  if (!items.length) return "\n" + theme.fg("muted", "No matching web results");
  return "\n" + previewLines(searchOutputLines(items), expanded, theme, width).join("\n");
}

/** Fetch's folded preview is bounded by terminal rows, including wrapped long lines. */
function formatFetch(details: FetchDetails | undefined, expanded: boolean, theme: Theme, width: number): string {
  if (!details) return "\n" + theme.fg("muted", "Page preview unavailable.");
  const body = safeText(details.content).replace(/\t/g, "   ");
  const bodyLines = body.split("\n");
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
  const lines = ["", ...previewLines(formatFetchLines(details.title, bodyLines), expanded, theme, width)];
  if (details.truncated) {
    const path = `Full output: ${safeText(details.fullOutputPath)}. `;
    const warning = details.truncatedBy === "bytes"
      ? `Truncated: ${details.outputLines} lines shown (${formatSize(FETCH_MAX_BYTES)} limit)`
      : `Truncated: showing ${details.outputLines} of ${details.totalLines} lines`;
    lines.push("", theme.fg("warning", `[${path}${warning}]`));
  }
  return lines.join("\n");
}

function formatResult(operation: Operation, result: AgentToolResult<unknown>, expanded: boolean, theme: Theme, width: number): string {
  return operation === "search"
    ? formatSearch(result.details, expanded, theme, width)
    : formatFetch(fetchDetailsOf(result.details), expanded, theme, width);
}

/** A compact Pi-style result: output preview, expand hint, warning footer,
 * then the shared timer. Errors use the same bounded visual preview.
 */
class WebResult implements Component {
  private readonly text = new Text("", 0, 0);
  readonly operation: Operation;
  private theme!: Theme;
  private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
  private timer = "";
  private failed = false;
  private result?: AgentToolResult<unknown>;
  private pending = true;
  private lastWidth = 0;
  private source = "";

  constructor(operation: Operation) { this.operation = operation; }

  update(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RenderContext) {
    this.theme = theme;
    this.options = options;
    this.failed = context.isError;
    this.timer = toolTimerText(context, options.isPartial);
    if (this.failed) {
      const raw = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      this.source = safeText(raw) || "Request failed.";
      return;
    }
    this.result = result;
    this.pending = true;
  }

  invalidate() { this.text.invalidate(); }

  private renderError(width: number): string[] {
    const styled = this.source.split("\n").map(line => this.theme.fg("error", line));
    const text = previewStyledLines(styled, this.options.expanded, this.theme, width).join("\n");
    const rows = new Text(text, 0, 0).render(width).map(line => clip(line, width));
    if (this.timer) {
      if (rows.length > 0) rows.push("");
      rows.push(clip(this.theme.fg("muted", this.timer), width));
    }
    return rows;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.failed) return this.renderError(width);
    if (this.pending || (!this.options.expanded && this.lastWidth !== width)) {
      this.lastWidth = width;
      const body = this.options.isPartial ? "" : formatResult(this.operation, this.result!, this.options.expanded, this.theme, width);
      const timerLine = this.timer ? this.theme.fg("muted", this.timer) : "";
      const text = [body, timerLine].filter(Boolean).join("\n\n");
      // Keep a blank line between the call and a timer-only result.
      this.text.setText(!body && timerLine ? `\n${text}` : text);
      this.pending = false;
    }
    return this.text.render(width).map(line => clip(line, width));
  }
}

function resultRenderer(operation: Operation) {
  return (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component => {
    const previous = context.lastComponent;
    const component = previous instanceof WebResult && previous.operation === operation ? previous : new WebResult(operation);
    component.update(result, options, theme, context);
    return component;
  };
}

export const renderSearchResult = resultRenderer("search");
export const renderFetchResult = resultRenderer("fetch");
