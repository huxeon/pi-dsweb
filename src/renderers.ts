import {
  formatSize, keyHint,
  type AgentToolResult, type Theme, type ToolDefinition, type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { displayLine, FETCH_MAX_BYTES, formatFetchLines, safeText, type FetchDetails, type SearchItemView } from "./presentation.ts";
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

function mutedHint(theme: Theme, text: string, hint: string): string {
  // keyHint starts with the key name: keep a space after the leading text.
  return theme.fg("muted", text) + " " + keyHint("app.tools.expand", hint) + theme.fg("muted", ")");
}

export function renderSearchCall(args: Partial<SearchInput>, theme: Theme, context: RenderContext): Component {
  startToolTimer(context);
  const query = typeof args.query === "string" ? safeText(args.query) : "";
  const flags = [
    typeof args.count === "number" ? `count ${args.count}` : "",
    args.need_content === true ? "content" : "",
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
    (typeof args.url === "string" && args.url ? theme.fg("accent", safeText(args.url)) : theme.fg("muted", "...")));
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
    lines.push(`${index + 1}. ${displayLine(item.title)}`);
    if (item.url) lines.push(displayLine(item.url));
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

/** Prepare text only; terminal wrapping and folding happen once in WebResult. */
function resultContent(operation: Operation, value: unknown, theme: Theme): { body: string; warning: string } {
  let lines: string[];
  let warning = "";
  if (operation === "search") {
    const items = searchItemsOf(value);
    if (!items || !items.length) {
      return { body: theme.fg("muted", items ? "No matching web results" : "Search preview unavailable."), warning };
    }
    lines = searchOutputLines(items);
  } else {
    const details = fetchDetailsOf(value);
    if (!details) return { body: theme.fg("muted", "Page preview unavailable."), warning };
    const bodyLines = safeText(details.content).replace(/\t/g, "   ").split("\n");
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    lines = formatFetchLines(details.title, bodyLines);
    if (details.truncated) {
      const limit = details.truncatedBy === "bytes"
        ? `Truncated: ${details.outputLines} lines shown (${formatSize(FETCH_MAX_BYTES)} limit)`
        : `Truncated: showing ${details.outputLines} of ${details.totalLines} lines`;
      warning = theme.fg("warning", `[Full output: ${safeText(details.fullOutputPath)}. ${limit}]`);
    }
  }
  return { body: lines.map(line => theme.fg("toolOutput", line)).join("\n"), warning };
}

/** Successes and errors share one visual-row preview and footer layout.
 * Text owns wrapping caches; already wrapped body rows are never laid out again.
 */
class WebResult implements Component {
  private readonly body = new Text("", 0, 0);
  private readonly warning = new Text("", 0, 0);
  private theme!: Theme;
  private expanded = false;
  private leadingBlank = false;
  private timer = "";

  constructor(readonly operation: Operation) {}

  update(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RenderContext) {
    this.theme = theme;
    this.expanded = options.expanded;
    this.leadingBlank = !context.isError;
    this.timer = toolTimerText(context, options.isPartial);
    let body = "", warning = "";
    if (context.isError) {
      const raw = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      body = (safeText(raw) || "Request failed.").split("\n").map(line => theme.fg("error", line)).join("\n");
    } else if (!options.isPartial) {
      ({ body, warning } = resultContent(this.operation, result.details, theme));
    }
    this.body.setText(body);
    this.warning.setText(warning);
  }

  invalidate() {
    this.body.invalidate();
    this.warning.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const all = this.body.render(width);
    // Copy Text's cached rows before adding hints or footers.
    const rows = this.expanded ? [...all] : all.slice(0, RESULT_PREVIEW_LINES);
    const hidden = all.length - rows.length;
    if (hidden > 0) {
      const hint = mutedHint(this.theme, `... (${hidden} more line${hidden === 1 ? "" : "s"},`, "to expand");
      rows.push(...new Text(hint, 0, 0).render(width));
    }
    const warning = this.warning.render(width);
    if (warning.length > 0) {
      if (rows.length > 0) rows.push("");
      rows.push(...warning);
    }
    if (this.timer) {
      if (rows.length > 0) rows.push("");
      rows.push(...new Text(this.theme.fg("muted", this.timer), 0, 0).render(width).map(line => line.trimEnd()));
    }
    if (this.leadingBlank && rows.length > 0) rows.unshift("");
    return rows.map(line => truncateToWidth(line, width, "..."));
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
