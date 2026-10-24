import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { initTheme, type AgentToolResult, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import extension from "../index.ts";
import { clearToolTimers, formatToolDuration, startToolTimer, toolTimerText } from "../src/timing.ts";

type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const context = (overrides: Partial<Context> = {}): Context => ({
  args: {}, state: {}, toolCallId: "timer", invalidate() {}, lastComponent: undefined,
  cwd: ".", executionStarted: true, argsComplete: true, isPartial: true,
  expanded: false, showImages: false, isError: false, durationMs: undefined, outputPad: 0, ...overrides,
});
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  t.after(clearToolTimers);
}
function collectTools() {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, () => void>();
  extension({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (name: string, handler: () => void) => { handlers.set(name, handler); return () => {}; },
  } as unknown as ExtensionAPI);
  return { tools, handlers };
}
initTheme("dark", false);

test("duration format matches Pi shell tools for seconds, minutes and hours", () => {
  for (const [ms, text] of [
    [0, "0.0s"], [1000, "1.0s"], [1200, "1.2s"], [59_900, "59.9s"],
    [60_000, "1m 0s"], [90_500, "1m 30s"], [3_600_000, "1h 0m 0s"], [3_723_000, "1h 2m 3s"],
  ] as const) assert.equal(formatToolDuration(ms), text);
  assert.equal(formatToolDuration(-1), "0.0s");
  assert.equal(formatToolDuration(Number.NaN), "0.0s");
});

test("clock starts with execution, not argument streaming, and invalidates once per second", (t) => {
  clock(t);
  let invalidations = 0;
  const ctx = context({ executionStarted: false, invalidate: () => { invalidations++; } });
  startToolTimer(ctx);
  assert.equal(toolTimerText(ctx, true), "");
  t.mock.timers.tick(3000);
  assert.equal(invalidations, 0);
  ctx.executionStarted = true;
  startToolTimer(ctx);
  assert.equal(toolTimerText(ctx, true), "Elapsed 0.0s");
  assert.equal(toolTimerText(ctx, true), "Elapsed 0.0s");
  t.mock.timers.tick(1000);
  assert.equal(invalidations, 1);
  assert.equal(toolTimerText(ctx, true), "Elapsed 1.0s");
  t.mock.timers.tick(1000);
  assert.equal(invalidations, 2);
  assert.equal(toolTimerText(ctx, true), "Elapsed 2.0s");
});

test("final Took time uses recorded duration and stops subsequent redraws", (t) => {
  clock(t);
  let invalidations = 0;
  const ctx = context({ invalidate: () => { invalidations++; } });
  startToolTimer(ctx);
  toolTimerText(ctx, true);
  t.mock.timers.tick(2000);
  assert.equal(invalidations, 2);
  ctx.durationMs = 1200;
  assert.equal(toolTimerText(ctx, false), "Took 1.2s");
  t.mock.timers.tick(5000);
  assert.equal(invalidations, 2);
  assert.equal(toolTimerText(ctx, false), "Took 1.2s");
  ctx.durationMs = undefined;
  assert.equal(toolTimerText(ctx, false), "Took 2.0s");
  t.mock.timers.tick(5000);
  assert.equal(toolTimerText(ctx, false), "Took 2.0s");
});

test("errors stop a running clock even when a caller still marks the update partial", (t) => {
  clock(t);
  let invalidations = 0;
  const ctx = context({ invalidate: () => { invalidations++; } });
  startToolTimer(ctx);
  toolTimerText(ctx, true);
  t.mock.timers.tick(1000);
  ctx.isError = true;
  assert.equal(toolTimerText(ctx, true), "Took 1.0s");
  t.mock.timers.tick(3000);
  assert.equal(invalidations, 1);
  assert.equal(toolTimerText(ctx, true), "Took 1.0s");
});

test("concurrent tool rows keep independent clocks and stop independently", (t) => {
  clock(t);
  let firstInvalidations = 0;
  let secondInvalidations = 0;
  const first = context({ invalidate: () => { firstInvalidations++; } });
  const second = context({ invalidate: () => { secondInvalidations++; } });
  startToolTimer(first);
  toolTimerText(first, true);
  t.mock.timers.tick(1000);
  startToolTimer(second);
  toolTimerText(second, true);
  t.mock.timers.tick(1000);
  assert.equal(toolTimerText(first, true), "Elapsed 2.0s");
  assert.equal(toolTimerText(second, true), "Elapsed 1.0s");
  toolTimerText(first, false);
  t.mock.timers.tick(1000);
  assert.equal(firstInvalidations, 2);
  assert.equal(secondInvalidations, 2);
  assert.equal(toolTimerText(second, true), "Elapsed 2.0s");
});

test("shutdown/reload cleanup is idempotent and does not resurrect stopped clocks", (t) => {
  clock(t);
  const { handlers } = collectTools();
  assert.deepEqual([...handlers.keys()], ["session_shutdown"]);
  let invalidations = 0;
  const ctx = context({ invalidate: () => { invalidations++; } });
  startToolTimer(ctx);
  toolTimerText(ctx, true);
  t.mock.timers.tick(1000);
  handlers.get("session_shutdown")!();
  handlers.get("session_shutdown")!();
  t.mock.timers.tick(5000);
  assert.equal(invalidations, 1);
  assert.equal(toolTimerText(ctx, true), "Elapsed 1.0s");
  t.mock.timers.tick(1000);
  assert.equal(invalidations, 1);
});

test("restored final rows use recorded time without starting an interval or inventing a start", (t) => {
  clock(t);
  let invalidations = 0;
  const ctx = context({ executionStarted: false, isPartial: false, durationMs: 90_000, invalidate: () => { invalidations++; } });
  assert.equal(toolTimerText(ctx, false), "Took 1m 30s");
  ctx.durationMs = undefined;
  assert.equal(toolTimerText(ctx, false), "");
  t.mock.timers.tick(10_000);
  assert.equal(invalidations, 0);
});

test("both registered tools drive live Elapsed and final Took through Pi's actual UI", async (t) => {
  clock(t);
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-offline-timer";
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  let release: ((response: Response) => void) | undefined;
  const transport = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { release = resolve; }));
  t.after(() => release?.(new Response(JSON.stringify({ results: [] }))));
  const { tools } = collectTools();
  for (const tool of tools) {
    let redraws = 0;
    const params = tool.name === "web_search" ? { query: "test query" } : { url: "https://example.com" };
    const component = new ToolExecutionComponent(tool.name, "host-timer", params, {}, tool,
      { requestRender() { redraws++; } } as unknown as TUI, process.cwd());
    const output = () => component.render(100).map(stripTerminalSequences).join("\n");
    component.setArgsComplete();
    assert(!output().includes("Elapsed"));
    component.markExecutionStarted();
    const updates: AgentToolResult<unknown>[] = [];
    const pending = tool.execute("timer-execution", params, undefined, update => {
      updates.push(update);
      component.updateResult({ ...update, isError: false }, true);
    }, {} as never);
    assert.deepEqual(updates, [{ content: [], details: undefined }]);
    assert(output().includes("Elapsed 0.0s"));
    const runningRows = output().split("\n").map(row => row.trim()).filter(Boolean);
    assert.equal(runningRows.length, 2); // Call header plus timer, no placeholder content.
    const bottom = () => output().split("\n").map(row => row.trim()).filter(Boolean).at(-1);
    assert.equal(bottom(), "Elapsed 0.0s");
    const elapsedRows = output().split("\n").map(row => row.trim());
    assert.equal(elapsedRows[elapsedRows.findIndex(row => row === "Elapsed 0.0s") - 1], "");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert(release);
    t.mock.timers.tick(1000);
    assert(output().includes("Elapsed 1.0s"));
    assert.equal(bottom(), "Elapsed 1.0s");
    t.mock.timers.tick(1000);
    assert(output().includes("Elapsed 2.0s"));
    const response = tool.name === "web_search" ? { results: [] } : { title: "Page title", content: "Page body" };
    release(new Response(JSON.stringify(response)));
    const result = await pending;
    component.updateResult({ ...result, isError: false, durationMs: 1200 });
    assert(output().includes("Took 1.2s"));
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      if (tool.name === "web_fetch") assert(output().includes("Page title"));
      assert.equal(bottom(), "Took 1.2s");
      const rows = output().split("\n").map(row => row.trim());
      const timerIndex = rows.findIndex(row => row === "Took 1.2s");
      assert(timerIndex > 0);
      assert.equal(rows[timerIndex - 1], "");
    }
    component.setExpanded(false);
    assert(!output().includes("Elapsed"));
    assert(!output().includes("Searching"));
    assert(!output().includes("Fetching"));
    assert.deepEqual(result.structuredContent, response);
    assert(!JSON.stringify(result).includes("Took"));
    assert(!JSON.stringify(result).includes("Elapsed"));
    const finalRedraws = redraws;
    t.mock.timers.tick(5000);
    assert.equal(redraws, finalRedraws);
  }
  assert.equal(transport.mock.callCount(), 2);
});

test("pre-aborted registered calls emit no initial update and make no network request", async (t) => {
  const { tools } = collectTools();
  let updates = 0;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call transport"); });
  const controller = new AbortController();
  controller.abort();
  for (const tool of tools) {
    await assert.rejects(tool.execute("aborted", tool.name === "web_search" ? { query: "q" } : { url: "https://example.com" },
      controller.signal, () => { updates++; }, {} as never), { name: "AbortError" });
  }
  assert.equal(updates, 0);
  assert.equal(network.mock.callCount(), 0);
});

test("Pi error and cancellation results freeze Took time and stop live redraws", (t) => {
  clock(t);
  const { tools } = collectTools();
  for (const message of ["Request failed", "Operation aborted"]) {
    let redraws = 0;
    const component = new ToolExecutionComponent("web_fetch", "failed-timer", { url: "https://example.com" }, {}, tools[1],
      { requestRender() { redraws++; } } as unknown as TUI, process.cwd());
    component.markExecutionStarted();
    component.updateResult({ content: [], details: undefined, isError: false }, true);
    t.mock.timers.tick(1000);
    component.updateResult({ content: [{ type: "text", text: message }], details: undefined, isError: true, durationMs: 1200 });
    const output = component.render(100).map(stripTerminalSequences).join("\n");
    assert(output.includes("Took 1.2s"));
    assert(output.includes(message));
    const rows = output.split("\n").map(row => row.trim());
    assert.equal(rows.filter(Boolean).at(-1), "Took 1.2s");
    assert.equal(rows[rows.findIndex(row => row === "Took 1.2s") - 1], "");
    assert(!output.includes("Elapsed"));
    const finished = redraws;
    t.mock.timers.tick(5000);
    assert.equal(redraws, finished);
  }
});
