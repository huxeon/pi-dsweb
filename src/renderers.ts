import {
  keyHint,
  type AgentToolResult, type Theme, type ToolDefinition, type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatFetchLines, safeText, singleLine, type FetchDetails, type SearchItemView } from "./presentation.ts";
import type { FetchInput, SearchInput } from "./schemas.ts";
import { startToolTimer, toolTimerText } from "./timing.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type Operation = "search" | "fetch";

/** Logical output lines shown before the user expands, like Pi's grep previews. */
const RESULT_PREVIEW_LINES = 5;
const ERROR_PREVIEW_LINES = 10;

/** Keep folded calls to one line; expanded calls wrap complete arguments. */
class CallLine implements Component {
  private text = "";
  private expanded = false;
  private readonly wrapped = new Text("", 0, 0);
  update(text: string, expanded: boolean) {
    if (text !== this.text) {
      this.text = text;
      this.wrapped.setText(text);
    }
    this.expanded = expanded;
  }
  invalidate() { this.wrapped.invalidate(); }
  render(width: number): string[] {
    if (width <= 0) return [];
    return this.expanded
      ? this.wrapped.render(width).map(line => clip(line, width))
      : [clip(this.text, width)];
  }
}

function callLine(context: RenderContext, text: string): Component {
  const component = context.lastComponent instanceof CallLine ? context.lastComponent : new CallLine();
  component.update(text, context.expanded);
  return component;
}

/** Built-in call lines wrap naturally and guard the zero-width case. */
class CallText implements Component {
  private readonly text = new Text("", 0, 0);
  update(text: string) { this.text.setText(text); }
  invalidate() { this.text.invalidate(); }
  render(width: number): string[] { return width <= 0 ? [] : this.text.render(width); }
}

function clip(line: string, width: number): string { return truncateToWidth(line, width, "..."); }

function mutedHint(theme: Theme, text: string, hint: string): string {
  // keyHint starts with the key name: keep a space after the leading text.
  return theme.fg("muted", text) + " " + keyHint("app.tools.expand", hint) + theme.fg("muted", ")");
}

export function renderSearchCall(args: Partial<SearchInput>, theme: Theme, context: RenderContext): Component {
  startToolTimer(context);
  const query = args.query ? (context.expanded ? safeText(args.query) : singleLine(args.query)) : "";
  const flags = [
    args.count !== undefined ? `count ${args.count}` : "",
    args.need_content ? "content" : "",
  ].filter(Boolean);
  return callLine(context,
    theme.fg("toolTitle", theme.bold("web_search")) + " " +
    (query ? theme.fg("accent", query) : theme.fg("muted", "...")) +
    (flags.length ? theme.fg("muted", ` (${flags.join(", ")})`) : ""),
  );
}

/** Built-in call lines keep the full argument and let Text wrap it. */
export function renderFetchCall(args: Partial<FetchInput>, theme: Theme, context: RenderContext): Component {
  startToolTimer(context);
  const component = context.lastComponent instanceof CallText ? context.lastComponent : new CallText();
  component.update(theme.fg("toolTitle", theme.bold("web_fetch")) + " " +
    (args.url ? theme.fg("accent", safeText(args.url)) : theme.fg("muted", "...")));
  return component;
}

function fetchDetailsOf(value: unknown): FetchDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const details = value as Partial<FetchDetails>;
  return typeof details.title === "string" && typeof details.bytes === "number" &&
    typeof details.content === "string" && typeof details.truncated === "boolean" &&
    typeof details.totalLines === "number" && typeof details.outputLines === "number"
    ? details as FetchDetails : undefined;
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
  return typeof item.title === "string" && typeof item.domain === "string" &&
    typeof item.url === "string" && typeof item.snippet === "string";
}

/** Validate persisted UI details as well as freshly generated tool output. */
function searchItemsOf(value: unknown): SearchItemView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // Array.from also checks sparse slots instead of silently skipping them.
  const items = Array.from(value);
  return items.every(isSearchItem) ? items : undefined;
}

function previewLines(all: readonly string[], expanded: boolean, theme: Theme): string[] {
  const shown = expanded ? all : all.slice(0, RESULT_PREVIEW_LINES);
  const hidden = all.length - shown.length;
  const lines = ["", ...shown.map(line => theme.fg("toolOutput", line))];
  if (hidden > 0) {
    lines.push(mutedHint(theme, `... (${hidden} more line${hidden === 1 ? "" : "s"},`, "to expand"));
  }
  return lines;
}

function formatSearch(details: unknown, expanded: boolean, theme: Theme): string {
  const items = searchItemsOf(details);
  if (!items) return "\n" + theme.fg("muted", "Search preview unavailable.");
  if (!items.length) return "\n" + theme.fg("muted", "No matching web results");
  return previewLines(searchOutputLines(items), expanded, theme).join("\n");
}

/** Fetch previews the same text prefix as search; expansion reveals the remainder. */
function formatFetch(details: FetchDetails | undefined, expanded: boolean, theme: Theme): string {
  if (!details) return "\n" + theme.fg("muted", "Page preview unavailable.");
  const body = safeText(details.content).replace(/\t/g, "   ");
  const bodyLines = body.split("\n");
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
  const lines = previewLines(formatFetchLines(details.title, bodyLines), expanded, theme);
  if (details.truncated) {
    lines.push("", theme.fg("warning", `[Truncated: showing ${details.outputLines} of ${details.totalLines} lines]`));
  }
  return lines.join("\n");
}

function formatResult(operation: Operation, result: AgentToolResult<unknown>, expanded: boolean, theme: Theme): string {
  return operation === "search"
    ? formatSearch(result.details, expanded, theme)
    : formatFetch(fetchDetailsOf(result.details), expanded, theme);
}

/** A compact Pi-style result: leading blank line, output preview, expand hint,
 * warning footer, then the shared timer. Errors keep a bounded visual preview.
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

  /** Pi's fallback previews the first ten logical lines and expands to the full text. */
  private renderError(width: number): string[] {
    const lines = this.source.split("\n");
    const shown = this.options.expanded ? lines : lines.slice(0, ERROR_PREVIEW_LINES);
    const hidden = lines.length - shown.length;
    let text = shown.map(line => this.theme.fg("error", line)).join("\n");
    if (hidden > 0) {
      text += "\n" + this.theme.fg("muted", `... (${hidden} more lines,`) + " " +
        keyHint("app.tools.expand", "to expand") + this.theme.fg("muted", ")");
    }
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
    if (this.pending) {
      const body = this.options.isPartial ? "" : formatResult(this.operation, this.result!, this.options.expanded, this.theme);
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
