import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export interface CompletedStreamStats {
  startTime: number;
  endTime: number;
  firstTokenTime: number | null;
  toolExecutionMs: number;
  model: string;
  outputTokens: number;
  reasoningTokens: number;
  streamingMs: number;
  mode?: string;
}

interface SessionModelStats {
  totalDurationMs: number;
  totalToolExecutionMs: number;
  totalTtftMs: number;
  ttftCount: number;
  responseCount: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalStreamingMs: number;
}

/** Input passed from cleanupStreamState to record timing stats. */
export interface CompletedStreamInput {
  /** Wall-clock end time of the stream. */
  endTime: number;
  /** Server start time of the stream (will be translated to renderer clock). */
  serverStartTime: number;
  serverFirstTokenTime: number | null;
  toolExecutionMs: number;
  /** Start times of tools that never completed (aborted/error). */
  pendingToolStarts: Iterable<number>;
  model: string;
  mode?: string;
  /** Backend-provided duration (preferred over renderer-based timing). */
  durationMsFromMetadata?: number;
  /** Cumulative usage from TokenTracker (preferred for token counts). */
  cumulativeUsage?: LanguageModelV2Usage;
  /** Fallback usage from message metadata (for abort/error cases). */
  metadataUsage?: { outputTokens?: number; reasoningTokens?: number };
  /** Translates server timestamps to renderer clock. */
  translateServerTime: (serverTime: number) => number;
}

/**
 * Manages per-session and last-completed-stream timing statistics.
 *
 * Extracted from StreamingMessageAggregator as part of H7.
 * The active-stream timing query (getActiveStreamTimingStats) stays in the
 * aggregator because it needs live access to active stream contexts.
 */
export class StreamingStatsService {
  private lastCompletedStreamStats: CompletedStreamStats | null = null;
  private sessionTimingStats: Record<string, SessionModelStats> = {};

  /** Clear all session timing stats (in-memory only). */
  clearSessionTimingStats(): void {
    this.sessionTimingStats = {};
    this.lastCompletedStreamStats = null;
  }

  /** Get timing statistics from the last completed stream. */
  getLastCompletedStreamStats(): CompletedStreamStats | null {
    return this.lastCompletedStreamStats;
  }

  /**
   * Record a completed stream's timing stats.
   * Called from cleanupStreamState after the stream has ended.
   */
  recordCompletedStream(input: CompletedStreamInput): void {
    const { endTime, translateServerTime, serverStartTime, serverFirstTokenTime } = input;

    const fallbackStartTime = translateServerTime(serverStartTime);
    const fallbackDurationMs = Math.max(0, endTime - fallbackStartTime);
    const durationMs =
      typeof input.durationMsFromMetadata === "number" &&
      Number.isFinite(input.durationMsFromMetadata)
        ? input.durationMsFromMetadata
        : fallbackDurationMs;

    const ttftMs =
      serverFirstTokenTime !== null ? Math.max(0, serverFirstTokenTime - serverStartTime) : null;

    const outputTokens =
      input.cumulativeUsage?.outputTokens ?? input.metadataUsage?.outputTokens ?? 0;
    const reasoningTokens =
      input.cumulativeUsage?.reasoningTokens ?? input.metadataUsage?.reasoningTokens ?? 0;

    // Account for in-progress tool calls (can happen on abort/error)
    let totalToolExecutionMs = input.toolExecutionMs;
    const serverEndTime = serverStartTime + durationMs;
    for (const toolStartTime of input.pendingToolStarts) {
      const toolMs = serverEndTime - toolStartTime;
      if (toolMs > 0) {
        totalToolExecutionMs += toolMs;
      }
    }

    // Streaming duration excludes TTFT and tool execution - used for avg tok/s
    const streamingMs = Math.max(0, durationMs - (ttftMs ?? 0) - totalToolExecutionMs);

    const startTime = endTime - durationMs;
    const firstTokenTime = ttftMs !== null ? startTime + ttftMs : null;
    this.lastCompletedStreamStats = {
      startTime,
      endTime,
      firstTokenTime,
      toolExecutionMs: totalToolExecutionMs,
      model: input.model,
      outputTokens,
      reasoningTokens,
      streamingMs,
      mode: input.mode,
    };

    // Use composite key model:mode for per-model+mode stats
    const statsKey = input.mode ? `${input.model}:${input.mode}` : input.model;

    const modelStats = this.sessionTimingStats[statsKey] ?? {
      totalDurationMs: 0,
      totalToolExecutionMs: 0,
      totalTtftMs: 0,
      ttftCount: 0,
      responseCount: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalStreamingMs: 0,
    };
    modelStats.totalDurationMs += durationMs;
    modelStats.totalToolExecutionMs += totalToolExecutionMs;
    modelStats.responseCount += 1;
    modelStats.totalOutputTokens += outputTokens;
    modelStats.totalReasoningTokens += reasoningTokens;
    modelStats.totalStreamingMs += streamingMs;
    if (ttftMs !== null) {
      modelStats.totalTtftMs += ttftMs;
      modelStats.ttftCount += 1;
    }
    this.sessionTimingStats[statsKey] = modelStats;
  }

  /**
   * Get aggregate timing statistics across all completed streams in this session.
   * Totals are computed on-the-fly from per-model data.
   */
  getSessionTimingStats(): {
    totalDurationMs: number;
    totalToolExecutionMs: number;
    totalStreamingMs: number;
    averageTtftMs: number | null;
    responseCount: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        mode?: string;
      }
    >;
  } | null {
    const modelEntries = Object.entries(this.sessionTimingStats);
    if (modelEntries.length === 0) return null;

    let totalDurationMs = 0;
    let totalToolExecutionMs = 0;
    let totalStreamingMs = 0;
    let totalTtftMs = 0;
    let ttftCount = 0;
    let responseCount = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;

    const byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        mode?: string;
      }
    > = {};

    for (const [key, stats] of modelEntries) {
      // Parse composite key: "model" or "model:mode"
      let mode: string | undefined;
      if (key.endsWith(":plan")) {
        mode = "plan";
      } else if (key.endsWith(":exec")) {
        mode = "exec";
      }

      totalDurationMs += stats.totalDurationMs;
      totalToolExecutionMs += stats.totalToolExecutionMs;
      totalStreamingMs += stats.totalStreamingMs ?? 0;
      totalTtftMs += stats.totalTtftMs;
      ttftCount += stats.ttftCount;
      responseCount += stats.responseCount;
      totalOutputTokens += stats.totalOutputTokens;
      totalReasoningTokens += stats.totalReasoningTokens;

      byModel[key] = {
        totalDurationMs: stats.totalDurationMs,
        totalToolExecutionMs: stats.totalToolExecutionMs,
        totalStreamingMs: stats.totalStreamingMs ?? 0,
        averageTtftMs: stats.ttftCount > 0 ? stats.totalTtftMs / stats.ttftCount : null,
        responseCount: stats.responseCount,
        totalOutputTokens: stats.totalOutputTokens,
        totalReasoningTokens: stats.totalReasoningTokens,
        mode,
      };
    }

    return {
      totalDurationMs,
      totalToolExecutionMs,
      totalStreamingMs,
      averageTtftMs: ttftCount > 0 ? totalTtftMs / ttftCount : null,
      responseCount,
      totalOutputTokens,
      totalReasoningTokens,
      byModel,
    };
  }
}
