import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd } from "@/common/orpc/types";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";

/** Shape of the init-hook state for display purposes. */
export interface InitStateSnapshot {
  status: "running" | "success" | "error";
  hookPath: string;
  lines: Array<{ line: string; isError: boolean }>;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  truncatedLines?: number;
}

/** Callbacks the InitStateHandler needs from the host aggregator. */
export interface InitStateCallbacks {
  /** Called when cache invalidation is needed (init output changed). */
  onInvalidate: () => void;
  /**
   * Called from init-end when there's an active pending-stream start time.
   * Resets the grace period so slow inits don't trigger false retry barriers.
   */
  onResetPendingStreamStart: () => void;
}

/**
 * Manages workspace init-hook lifecycle (init-start → init-output → init-end).
 *
 * State is ephemeral (not persisted to history). The handler throttles cache
 * invalidation during fast init output to avoid per-line re-renders, and
 * deduplicates replayed init events on reconnect.
 */
export class InitStateHandler {
  private state: InitStateSnapshot | null = null;

  // Reconnect replay re-emits init-start for the same running init. Snapshot
  // the already-visible prefix so replay can skip those previously rendered
  // lines without collapsing legitimate duplicates later on.
  private replayInitVisiblePrefix: Array<{ line: string; isError: boolean }> | null = null;
  private replayInitVisiblePrefixIndex = 0;
  private appliedReplayInitEvents = new WeakSet<object>();
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly THROTTLE_MS = 100;

  constructor(private readonly callbacks: InitStateCallbacks) {}

  getSnapshot(): InitStateSnapshot | null {
    return this.state;
  }

  flushPendingOutput(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.callbacks.onInvalidate();
  }

  /** Returns true if the message was consumed as an init event. */
  handleMessage(data: WorkspaceChatMessage): boolean {
    if (isInitStart(data)) {
      return this.handleInitStart(data);
    }
    if (isInitOutput(data)) {
      return this.handleInitOutput(data);
    }
    if (isInitEnd(data)) {
      return this.handleInitEnd(data);
    }
    return false;
  }

  /** Returns true if a replay init event should be skipped (already applied). */
  shouldSkipReplayEvent(data: WorkspaceChatMessage): boolean {
    if (
      (data as { replay?: boolean }).replay !== true ||
      (!isInitStart(data) && !isInitOutput(data) && !isInitEnd(data))
    ) {
      return false;
    }

    if (this.appliedReplayInitEvents.has(data as object)) {
      return true;
    }

    this.appliedReplayInitEvents.add(data as object);
    return false;
  }

  // ----- Private helpers -----

  private clearReplayInitVisiblePrefix(): void {
    this.replayInitVisiblePrefix = null;
    this.replayInitVisiblePrefixIndex = 0;
  }

  private shouldSkipVisibleReplayInitOutput(line: string, isError: boolean): boolean {
    const prefix = this.replayInitVisiblePrefix;
    if (!prefix) {
      return false;
    }

    const nextVisibleLine = prefix[this.replayInitVisiblePrefixIndex];
    if (nextVisibleLine?.line !== line || nextVisibleLine?.isError !== isError) {
      this.clearReplayInitVisiblePrefix();
      return false;
    }

    this.replayInitVisiblePrefixIndex += 1;
    if (this.replayInitVisiblePrefixIndex >= prefix.length) {
      this.clearReplayInitVisiblePrefix();
    }

    return true;
  }

  private handleInitStart(data: WorkspaceChatMessage): boolean {
    const start = data as { hookPath: string; timestamp: number; replay?: boolean };
    const isReplay = start.replay === true;
    if (
      isReplay &&
      this.state?.status === "running" &&
      this.state.hookPath === start.hookPath &&
      this.state.startTime === start.timestamp
    ) {
      // Reconnect replay re-emits init-start before replayed lines. Treat the
      // same running init as a no-op so switching back never clears the
      // visible SSH/setup output mid-replay.
      this.replayInitVisiblePrefix = [...this.state.lines];
      this.replayInitVisiblePrefixIndex = 0;
      return true;
    }

    this.clearReplayInitVisiblePrefix();
    this.state = {
      status: "running",
      hookPath: start.hookPath,
      lines: [],
      exitCode: null,
      startTime: start.timestamp,
      endTime: null,
    };
    this.callbacks.onInvalidate();
    return true;
  }

  private handleInitOutput(data: WorkspaceChatMessage): boolean {
    if (!this.state) {
      console.error("Received init-output without init-start", { data });
      return true;
    }
    const output = data as {
      line?: string;
      isError?: boolean;
      timestamp: number;
      replay?: boolean;
    };
    if (!output.line) {
      console.error("Received init-output with missing line field", { data });
      return true;
    }
    const line = output.line.trimEnd();
    const isError = output.isError === true;
    const isReplay = output.replay === true;
    if (isReplay && this.shouldSkipVisibleReplayInitOutput(line, isError)) {
      return true;
    }

    // Truncation: keep only the most recent MAX_LINES (matches backend).
    if (this.state.lines.length >= INIT_HOOK_MAX_LINES) {
      this.state.lines.shift();
      this.state.truncatedLines = (this.state.truncatedLines ?? 0) + 1;
    }
    this.state.lines.push({ line, isError });

    // Throttle cache invalidation during fast streaming to avoid re-render per line.
    this.throttleTimer ??= setTimeout(() => {
      this.throttleTimer = null;
      this.callbacks.onInvalidate();
    }, InitStateHandler.THROTTLE_MS);
    return true;
  }

  private handleInitEnd(data: WorkspaceChatMessage): boolean {
    this.clearReplayInitVisiblePrefix();
    if (!this.state) {
      console.error("Received init-end without init-start", { data });
      return true;
    }
    const end = data as { exitCode: number; timestamp: number; truncatedLines?: number };
    this.state.exitCode = end.exitCode;
    this.state.status = end.exitCode === 0 ? "success" : "error";
    this.state.endTime = end.timestamp;
    // Use backend truncation count if larger (covers replay of old data).
    if (end.truncatedLines && end.truncatedLines > (this.state.truncatedLines ?? 0)) {
      this.state.truncatedLines = end.truncatedLines;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.callbacks.onResetPendingStreamStart();
    this.callbacks.onInvalidate();
    return true;
  }
}
