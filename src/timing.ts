import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
interface TimerState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}
const activeTimers = new Set<TimerState>();

function timerState(context: RenderContext): TimerState {
  const state = context.state as { dswebTimer?: TimerState };
  return state.dswebTimer ??= {};
}
function stopTimer(state: TimerState) {
  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  activeTimers.delete(state);
}

/** Match Pi's built-in shell duration format without importing private modules. */
export function formatToolDuration(ms: number): string {
  const seconds = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes < 60 ? `${minutes}m ${remainder}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Called from renderCall: argument streaming must not start the execution clock. */
export function startToolTimer(context: RenderContext): void {
  const state = timerState(context);
  if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
}

/** Live Elapsed text, then Took text using Pi's recorded final duration. */
export function toolTimerText(context: RenderContext, isPartial: boolean): string {
  const state = timerState(context);
  const running = isPartial && !context.isError;
  if (!running) {
    state.endedAt ??= Date.now();
    stopTimer(state);
  }
  if (!isPartial && typeof context.durationMs === "number" && Number.isFinite(context.durationMs)) {
    return `Took ${formatToolDuration(context.durationMs)}`;
  }
  if (state.startedAt === undefined) return "";
  if (running && state.endedAt === undefined && state.interval === undefined) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
    activeTimers.add(state);
  }
  return `${running ? "Elapsed" : "Took"} ${formatToolDuration((state.endedAt ?? Date.now()) - state.startedAt)}`;
}

/** Quit, reload and session replacement must not leave redraw intervals alive. */
export function clearToolTimers(): void {
  for (const state of activeTimers) {
    state.endedAt ??= Date.now();
    stopTimer(state);
  }
}
