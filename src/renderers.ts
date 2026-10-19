import {
  getMarkdownTheme, keyHint, truncateHead,
  type AgentToolResult, type Theme, type ToolDefinition, type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { safeText, singleLine, type FetchDetails, type SearchItemView } from "./presentation.ts";
import type { FetchInput, SearchInput } from "./schemas.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type Operation = "search" | "fetch";

class CompactLines implements Component {
  constructor(private lines: (width: number) => string[]) {}
  update(lines: (width: number) => string[]) { this.lines = lines; }
  invalidate() {}
  render(width: number): string[] {
    return width > 0 ? this.lines(width).map(line => truncateToWidth(line, width, "...")) : [];
  }
}

function compact(context: RenderContext, lines: (width: number) => string[]): Component {
  if (context.lastComponent instanceof CompactLines) {
    context.lastComponent.update(lines);
    return context.lastComponent;
  }
  return new CompactLines(lines);
}

/** Preserve theme SGR styling, but not terminal commands or OSC hyperlinks. */
function safeStyledLine(line: string): string {
  return line.split(/(\x1b\[[0-9;:]*m)/g).map(part =>
    /^\x1b\[[0-9;:]*m$/.test(part) ? part : safeText(part).replace(/[\r\n]/g, " "),
  ).join("");
}

function clip(line: string, width: number): string { return truncateToWidth(line, width, "..."); }

/** Reserve space for a short suffix, rather than letting long titles/domains
 * hide it. At narrow widths, put each field on its own row.
 */
function columns(left: string, right: string, width: number): string[] {
  const rightWidth = visibleWidth(right);
  if (width < 32 || rightWidth > width / 2) return [clip(left, width), clip(right, width)];
  const leftWidth = Math.max(1, width - rightWidth - 3);
  return [clip(left, leftWidth) + " · " + right];
}

function duration(context: RenderContext): string {
  return typeof context.durationMs === "number" ? `${(context.durationMs / 1000).toFixed(1)}s` : "";
}

export function renderSearchCall(args: Partial<SearchInput>, theme: Theme, context: RenderContext): Component {
  return compact(context, () => {
    const query = singleLine(args.query ?? "");
    const options = [args.count !== undefined ? `count=${args.count}` : "", args.need_content ? "with content" : ""].filter(Boolean).join(" · ");
    return [
      theme.fg("toolTitle", theme.bold("WebSearch")) +
      (query ? "  " + theme.fg("accent", query) : "") +
      (options ? theme.fg("muted", `  (${options})`) : "") +
      (context.executionStarted && context.isPartial ? theme.fg("muted", " · Searching...") : ""),
    ];
  });
}

export function renderFetchCall(args: Partial<FetchInput>, theme: Theme, context: RenderContext): Component {
  return compact(context, () => [
    theme.fg("toolTitle", theme.bold("WebFetch")) +
    (args.url ? "  " + theme.fg("accent", singleLine(args.url, 300)) : "") +
    (context.executionStarted && context.isPartial ? theme.fg("muted", " · Fetching...") : ""),
  ]);
}

function fetchDetailsOf(value: unknown): FetchDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const details = value as Partial<FetchDetails>;
  return typeof details.title === "string" && typeof details.bytes === "number" &&
    typeof details.content === "string" && typeof details.truncated === "boolean"
    ? details as FetchDetails : undefined;
}

/** Limit UI preview by rendered rows, independently of model output limits. */
class DisplayMarkdown implements Component {
  private readonly markdown: Markdown;
  constructor(text: string) {
    this.markdown = new Markdown(safeText(text), 0, 0, getMarkdownTheme());
  }
  invalidate() { this.markdown.invalidate(); }
  render(width: number): string[] { return this.preview(width).lines; }
  preview(width: number): { lines: string[]; limited: boolean } {
    if (width <= 0) return { lines: [], limited: false };
    const rows = this.markdown.render(width);
    return { lines: rows.slice(0, 40).map(line => clip(safeStyledLine(line), width)), limited: rows.length > 40 };
  }
}

/** A result component survives expansion, updates and redraws through
 * context.lastComponent. Cached Markdown/Text is rebuilt only when its content
 * or theme changes; renderer invalidation still clears layout/theme caches.
 */
class WebResult implements Component {
  private result!: AgentToolResult<unknown>;
  private options!: ToolRenderResultOptions;
  private theme!: Theme;
  private context!: RenderContext;
  private text = "";
  private body = "";
  private markdown?: DisplayMarkdown;
  private errorText?: Text;
  private errorSourceTruncated = false;

  constructor(readonly operation: Operation) {}
  update(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RenderContext) {
    const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const body = this.operation === "fetch" ? fetchDetailsOf(result.details)?.content ?? "" : "";
    if (body !== this.body || theme !== this.theme) this.markdown = undefined;
    if (text !== this.text || theme !== this.theme) this.errorText = undefined;
    this.body = body;
    this.result = result;
    this.options = options;
    this.theme = theme;
    this.context = context;
    this.text = text;
  }
  invalidate() {
    this.markdown?.invalidate();
    // Text stores styled strings: regenerate them rather than retaining colors.
    this.errorText = undefined;
  }
  private error(width: number): string[] {
    if (!this.errorText) {
      const preview = truncateHead(safeText(this.text), { maxBytes: 16 * 1024, maxLines: 500 });
      this.errorSourceTruncated = preview.truncated;
      this.errorText = new Text(this.theme.fg("error", preview.content || "Request failed."), 0, 0);
    }
    const rows = this.errorText.render(width);
    const limit = this.options.expanded ? 20 : 3;
    const limited = this.errorSourceTruncated || rows.length > limit;
    const lines = rows.slice(0, limited ? limit - 1 : limit).map(line => clip(safeStyledLine(line), width));
    if (limited) lines.push(clip(this.theme.fg("muted", this.options.expanded
      ? "... Error preview limited; original error is retained in the session."
      : "... " + keyHint("app.tools.expand", "for error details")), width));
    return lines;
  }
  private header(width: number, items?: SearchItemView[], details?: FetchDetails): string[] {
    const time = duration(this.context);
    const theme = this.theme;
    let lines: string[];
    if (this.operation === "fetch" && details) {
      const size = details.bytes < 1024 ? `${details.bytes} B` : `${(details.bytes / 1024).toFixed(1)} KiB`;
      lines = [clip(theme.fg("muted", [size, time].filter(Boolean).join(" · ")), width)];
      if (details.truncated) lines.push(clip(theme.fg("warning", "⚠ Content truncated for model"), width));
      if (this.options.expanded) lines.push("");
      const title = singleLine(details.title, 160);
      lines.push(clip(theme.fg("toolOutput", this.options.expanded ? theme.bold(title) : title), width));
    } else {
      const label = items ? (items.length ? `${items.length} result${items.length === 1 ? "" : "s"}` : "No matching web results")
        : this.operation === "search" ? "Search completed" : "Page retrieved";
      const styled = items && !items.length
        ? theme.fg("muted", label)
        : theme.fg("toolOutput", theme.bold(label));
      lines = time ? columns(styled, theme.fg("muted", time), width) : [clip(styled, width)];
    }
    return lines;
  }
  private item(item: SearchItemView, index: number, width: number, expanded: boolean): string[] {
    const theme = this.theme;
    const label = `${index + 1}. ${singleLine(item.title, 160)}`;
    const title = theme.fg("toolOutput", expanded ? theme.bold(label) : label);
    const domain = theme.fg("muted", singleLine(item.domain, 100));
    const lines = columns(title, domain, width);
    if (expanded) {
      if (item.url) lines.push(clip(theme.fg("muted", singleLine(item.url, 300)), width));
      if (item.snippet) lines.push(clip(theme.fg("toolOutput", singleLine(item.snippet, 240)), width));
    }
    return lines;
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.context.isError) return this.error(width);
    if (this.options.isPartial) return [clip(this.theme.fg("muted", this.operation === "search" ? "Searching..." : "Fetching..."), width)];
    const details = this.operation === "fetch" ? fetchDetailsOf(this.result.details) : undefined;
    const items = this.operation === "search" && Array.isArray(this.result.details)
      ? this.result.details as SearchItemView[] : undefined;
    const lines = this.header(width, items, details);
    if (!this.options.expanded) {
      items?.slice(0, 3).forEach((item, index) => lines.push(...this.item(item, index, width, false)));
      if (!items || items.length > 0) lines.push(clip(this.theme.fg("muted", keyHint("app.tools.expand", "to expand")), width));
      return lines;
    }
    if (this.operation === "search") {
      if (items) items.forEach((item, index) => lines.push("", ...this.item(item, index, width, true)));
      else lines.push(clip(this.theme.fg("muted", "Search preview unavailable."), width));
      return lines;
    }
    if (details) {
      this.markdown ??= new DisplayMarkdown(this.body || "(No page content returned.)");
      const preview = this.markdown.preview(width);
      lines.push("", ...preview.lines);
      if (preview.limited) lines.push("", clip(this.theme.fg("muted", "... Preview limited to 40 lines"), width));
    } else {
      lines.push(clip(this.theme.fg("muted", "Page preview unavailable."), width));
    }
    return lines;
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
