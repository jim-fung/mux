import type {
  MuxMessage,
  MuxMetadata,
  DisplayedMessage,
  CompactionRequestData,
  InlineSkillSnapshotMap,
} from "@/common/types/message";
import { createMuxMessage, isCompactionSummaryMetadata } from "@/common/types/message";

import {
  copyStreamLifecycleSnapshot,
  type StreamStartEvent,
  type StreamDeltaEvent,
  type UsageDeltaEvent,
  type StreamEndEvent,
  type StreamAbortEvent,
  type StreamAbortReasonSnapshot,
  type ToolCallStartEvent,
  type ToolCallDeltaEvent,
  type ToolCallEndEvent,
  type ReasoningDeltaEvent,
  type ReasoningEndEvent,
  type RuntimeStatusEvent,
  type StreamLifecycleEvent,
  type StreamLifecycleSnapshot,
} from "@/common/types/stream";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { TodoItem } from "@/common/types/tools";
import type { AssistedReviewHunk } from "@/common/types/review";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type {
  WorkspaceChatMessage,
  StreamErrorMessage,
  DeleteMessage,
  OnChatCursor,
} from "@/common/orpc/types";
import { isMuxMessage } from "@/common/orpc/types";
import {
  buildAggregateResponseCompleteMetadata,
  buildResponseCompleteMetadata,
  type ResponseCompleteHandler,
} from "./responseCompletionMetadata";
import {
  buildDisplayedMessagesForMessage,
  getTextPartContent,
  hasSuccessResult,
  mergeAdjacentParts,
  normalizeMessageRouteProvider,
  resolveRouteProvider,
} from "./displayedMessageBuilder";
import { showBrowserNotification } from "@/browser/utils/ui/showBrowserNotification";
import type { DynamicToolPart, DynamicToolPartPending } from "@/common/types/toolParts";
import { InitStateHandler } from "./aggregator/initStateHandler";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { TokenTracker } from "./aggregator/tokenTracker";
import { StreamingStatsService } from "./aggregator/streamingStatsService";
import { buildTranscriptTruncationPlan } from "./transcriptTruncationPlan";
import { computeRecencyTimestamp } from "./recency";
import { assert } from "@/common/utils/assert";
import {
  CONTEXT_BOUNDARY_KINDS,
  getContextBoundaryKind,
} from "@/common/utils/messages/compactionBoundary";
import {
  SIDE_QUESTION_ANSWER_METADATA_TYPE,
  isSideQuestionAnswerMessage as isSideQuestionAnswerMuxMessage,
  isSideQuestionUserMessage as isSideQuestionUserMuxMessage,
} from "@/common/utils/messages/sideQuestion";
import { isWorkflowResultMessage } from "@/common/utils/workflowRunMessages";

// H1: Schemas, parsers, and agent-skill-snapshot helpers extracted to dedicated modules.
import {
  parseLegacyNotifyRouting,
  parseTodoWriteInput,
  parseStatusSetSuccessResult,
  parseNotifySuccessResult,
  type AgentStatus,
} from "./aggregator/schemas";
import { MAX_DISPLAYED_MESSAGES, ALWAYS_KEEP_MESSAGE_TYPES } from "./aggregator/constants";
import {
  type AgentSkillSnapshotContent,
  getAgentSkillSnapshotDisplayCacheKey,
  getAgentSkillSnapshotKey,
  maybeCollectAgentSkillSnapshot,
  deriveInlineSkillSnapshotDisplayState,
} from "./aggregator/agentSkillSnapshot";
import { AgentStatusAdapter } from "./aggregator/agentStatusAdapter";
import { SkillStore, type LoadedSkill, type SkillLoadError } from "./aggregator/skillStore";
import { TodoStore } from "./aggregator/todoStore";
import { AssistedReviewHunkStore } from "./aggregator/assistedReviewHunkStore";
import {
  buildSideQuestionDisplayPlan,
  buildInterruptedMessageDisplay,
  type SideQuestionPlannerDeps,
} from "./aggregator/sideQuestionDisplayPlanner";

// Maximum number of messages to display in the DOM for performance
// Full history is still maintained internally for token counting and stats
// ---------------------------------------------------------------------------
// Re-exported types (kept here for backward compatibility)
// ---------------------------------------------------------------------------

/** Re-export for consumers that need the loaded skill type */
// Re-exported from skillStore for backward compatibility.
export type { LoadedSkill, SkillLoadError };

interface StreamingContext {
  /** Backend timestamp when stream started (Date.now()) */
  serverStartTime: number;
  /**
   * Offset to translate backend timestamps into the renderer clock.
   * Computed as: `Date.now() - lastServerTimestamp`.
   */
  clockOffsetMs: number;
  /** Most recent backend timestamp observed for this stream */
  lastServerTimestamp: number;

  isComplete: boolean;
  isCompacting: boolean;
  // Track the last known queued-follow-up state on the active stream itself so
  // background activity completion can still suppress intermediate notifications
  // after the workspace loses its live queued-message subscription.
  hasQueuedFollowUp: boolean;
  suppressNotification: boolean;
  isReplay: boolean;
  model: string;
  routedThroughGateway?: boolean;
  routeProvider?: string;

  /** Timestamp of first content token (text or reasoning delta) - backend Date.now() */
  serverFirstTokenTime: number | null;

  /** Accumulated tool execution time in ms */
  toolExecutionMs: number;
  /** Map of tool call start times for in-progress tool calls (backend timestamps) */
  pendingToolStarts: Map<string, number>;

  /** Agent id active for this stream. */
  agentId?: string;

  /** Legacy base mode (plan/exec/compact). */
  mode?: string;

  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
}

interface PendingCompactionRequest {
  parsed: CompactionRequestData;
  source?: "idle-compaction" | "auto-compaction";
}

function markRowsBeforeLatestContextBoundary(messages: DisplayedMessage[]): DisplayedMessage[] {
  let latestBoundarySequence: number | null = null;
  for (const message of messages) {
    if (message.type !== "compaction-boundary") {
      continue;
    }
    if (latestBoundarySequence === null || message.historySequence > latestBoundarySequence) {
      latestBoundarySequence = message.historySequence;
    }
  }

  if (latestBoundarySequence === null) {
    return messages;
  }

  let changed = false;
  const marked = messages.map((message) => {
    if (message.type !== "user" && message.type !== "assistant") {
      return message;
    }

    const isBeforeLatestContextBoundary = message.historySequence < latestBoundarySequence;
    if (message.isBeforeLatestContextBoundary === isBeforeLatestContextBoundary) {
      return message;
    }

    changed = true;
    return {
      ...message,
      isBeforeLatestContextBoundary: isBeforeLatestContextBoundary ? true : undefined,
    };
  });

  return changed ? marked : messages;
}

export class StreamingMessageAggregator {
  private messages = new Map<string, MuxMessage>();
  private activeStreams = new Map<string, StreamingContext>();

  private backgroundHandoffCompletion: ReturnType<typeof buildAggregateResponseCompleteMetadata> =
    undefined;

  // Derived value cache - invalidated as a unit on every mutation.
  // Adding a new cached value? Add it here and it will auto-invalidate.
  private displayedMessageCache = new Map<
    string,
    {
      version: number;
      agentSkillSnapshotCacheKey?: string;
      inlineSkillSnapshotsCacheKey?: string;
      messages: DisplayedMessage[];
    }
  >();
  private messageVersions = new Map<string, number>();
  private cache: {
    allMessages?: MuxMessage[];
    displayedMessages?: DisplayedMessage[];
  } = {};
  private recencyTimestamp: number | null = null;
  private lastResponseCompletedAt: number | null = null;

  /** Oldest historySequence from the server's last replay window.
   *  Used for reconnect cursors instead of the absolute minimum (which
   *  includes user-loaded older pages via loadOlderHistory). */
  private establishedOldestHistorySequence: number | null = null;

  // H7: Token tracking and usage extracted to TokenTracker.
  private tokenTracker: TokenTracker = new TokenTracker();

  // Current TODO list (updated when todo_write succeeds)
  // Incomplete lists persist across streams and reloads; fully completed lists clear
  // once the final stream finishes so stale plans do not linger in the UI.
  // H4: Todo + assisted-review tracking extracted to dedicated stores.
  private todoStore: TodoStore = new TodoStore();
  private reviewHunkStore: AssistedReviewHunkStore = new AssistedReviewHunkStore();

  // Agent status lifecycle (status_set persistence + transient displayStatus)
  private agentStatusAdapter: AgentStatusAdapter;

  // Agent-flagged "Assisted review" hunks (updated by review_pane_update).
  // Reconstructed from chat history on reload via processToolResult so the
  // H3: Skill tracking extracted to SkillStore.
  private skillStore: SkillStore = new SkillStore();

  // Whether to disable DOM message capping for this workspace.
  // Controlled via the HistoryHiddenMessage “Load all” button.
  private showAllMessages = false;
  // Workspace ID (used for status persistence)
  private readonly workspaceId: string | undefined;

  // Workspace init hook state machine (ephemeral, not persisted to history).
  // Encapsulates init-start/output/end lifecycle, replay dedup, and throttled
  // cache invalidation during fast init output streaming.
  private initStateHandler: InitStateHandler;

  // Track when we're waiting for stream-start after user message
  // Prevents retry barrier flash during normal send flow
  // Stores timestamp of when user message was sent (null = no pending stream)
  // IMPORTANT: We intentionally keep this timestamp until a stream actually starts
  // (or the user retries) so retry UI/backoff logic doesn't misfire on send failures.
  private pendingStreamStartTime: number | null = null;

  // Canonical backend-owned stream lifecycle. This distinguishes slow startup from a
  // genuinely interrupted/failed turn, including reconnects while PREPARING is still in flight.
  private streamLifecycle: StreamLifecycleSnapshot | null = null;

  // Last observed stream-abort reason (used to gate auto-retry).
  private lastAbortReason: StreamAbortReasonSnapshot | null = null;

  // Current pre-stream startup status.
  // This begins with runtime readiness for Coder, but also carries generic
  // startup breadcrumbs like "Loading tools..." while the request is preparing.
  private runtimeStatus: RuntimeStatusEvent | null = null;

  // Pending compaction request metadata for the next stream (set when user message arrives).
  // Used to infer compaction state before stream-start arrives.
  private pendingCompactionRequest: PendingCompactionRequest | null = null;

  // Model used for the pending send (set on user message) so the "starting" UI
  // reflects one-shot/compaction overrides instead of stale localStorage values.
  private pendingStreamModel: string | null = null;

  // A brand-new workspace can auto-navigate before onChat replays the first user turn.
  // Keep the startup barrier alive through that empty catch-up window until we see
  // either the real user message or a terminal stream event.
  private optimisticPendingStreamStart = false;
  private optimisticPendingStreamStartIdleCaughtUpCount = 0;

  // H7: Streaming timing stats extracted to StreamingStatsService.
  private statsService: StreamingStatsService = new StreamingStatsService();

  // Optimistic "interrupting" state: set before calling interruptStream
  // Shows "interrupting..." in StreamingBarrier until real stream-abort arrives
  private interruptingMessageId: string | null = null;

  // H7: Session timing stats managed by StreamingStatsService.

  // Workspace creation timestamp (used for recency calculation)
  // REQUIRED: Backend guarantees every workspace has createdAt via config.ts
  private readonly createdAt: string;
  // Workspace unarchived timestamp (used for recency calculation to bump restored workspaces)
  private unarchivedAt?: string;

  // Optional callback for navigating to a workspace (set by parent component)
  // Used for notification click handling in browser mode
  onNavigateToWorkspace?: (workspaceId: string) => void;

  // Optional callback when an assistant response completes (used for "notify on response" feature).
  // completedAt is non-null for all final streams and drives read-marking in App.tsx.
  // Only non-compaction completions also bump lastResponseCompletedAt (recency).
  onResponseComplete?: ResponseCompleteHandler;

  constructor(createdAt: string, workspaceId?: string, unarchivedAt?: string) {
    this.createdAt = createdAt;
    this.workspaceId = workspaceId;
    this.unarchivedAt = unarchivedAt;
    this.agentStatusAdapter = new AgentStatusAdapter(workspaceId);
    this.initStateHandler = new InitStateHandler({
      onInvalidate: () => this.invalidateCache(),
      // Reset pending stream start time so the grace period starts fresh after init completes.
      // This prevents false retry barriers for slow init (e.g., Coder workspace provisioning).
      onResetPendingStreamStart: () => {
        if (this.pendingStreamStartTime !== null) {
          this.setPendingStreamStartTime(Date.now());
        }
      },
    });
    this.updateRecency();
  }

  /** Update unarchivedAt timestamp (called when workspace is restored from archive) */
  setUnarchivedAt(unarchivedAt: string | undefined): void {
    this.unarchivedAt = unarchivedAt;
    this.updateRecency();
  }

  /**
   * Disable the displayed message cap for this workspace.
   * Intended for user-triggered “Load all” UI.
   */
  setShowAllMessages(showAllMessages: boolean): void {
    assert(typeof showAllMessages === "boolean", "setShowAllMessages requires boolean");
    if (this.showAllMessages === showAllMessages) {
      return;
    }
    this.showAllMessages = showAllMessages;
    this.invalidateCache();
  }

  /** Clear all session timing stats (in-memory only). */
  clearSessionTimingStats(): void {
    this.statsService.clearSessionTimingStats();
  }

  private updateStreamClock(context: StreamingContext, serverTimestamp: number): void {
    assert(context, "updateStreamClock requires context");
    assert(typeof serverTimestamp === "number", "updateStreamClock requires serverTimestamp");

    // Only update if this timestamp is >= the most recent one we've seen.
    // During stream replay, older historical parts may be re-emitted out of order.
    //
    // NOTE: This is a display-oriented clock translation (not true synchronization).
    // We refresh the offset whenever we see a newer backend timestamp. If the renderer clock
    // drifts significantly during a very long stream, the translated times may be off by a
    // small amount, which is acceptable for UI stats.
    if (serverTimestamp < context.lastServerTimestamp) {
      return;
    }

    context.lastServerTimestamp = serverTimestamp;
    context.clockOffsetMs = Date.now() - serverTimestamp;
  }

  /**
   * Detect the replay→live transition for reconnect streams.
   *
   * During reconnect, `replayStream()` emits all catch-up events with `replay: true`.
   * Once the catch-up phase is over, fresh live deltas arrive without the flag.
   * This helper flips `isReplay` to false on the first non-replay event so that
   * `streamPresentation.source` correctly transitions to "live" and smoothing
   * resumes instead of staying bypassed.
   *
   * IMPORTANT: Only call from content handlers (handleStreamDelta, handleReasoningDelta).
   * Tool events are not buffered by the reconnect relay and can arrive before replay
   * text finishes flushing — calling this from tool handlers would prematurely end
   * replay phase and reclassify catch-up content as live.
   */
  private syncReplayPhase(messageId: string, replay?: boolean): void {
    const context = this.activeStreams.get(messageId);
    if (context && context.isReplay && replay !== true) {
      context.isReplay = false;
    }
  }

  private translateServerTime(context: StreamingContext, serverTimestamp: number): number {
    assert(context, "translateServerTime requires context");
    assert(typeof serverTimestamp === "number", "translateServerTime requires serverTimestamp");

    return serverTimestamp + context.clockOffsetMs;
  }

  private bumpMessageVersion(messageId: string): void {
    const current = this.messageVersions.get(messageId) ?? 0;
    this.messageVersions.set(messageId, current + 1);
  }

  private markMessageDirty(messageId: string): void {
    this.bumpMessageVersion(messageId);
    this.invalidateCache();
  }

  private deleteMessage(messageId: string): boolean {
    const didDelete = this.messages.delete(messageId);
    if (didDelete) {
      this.displayedMessageCache.delete(messageId);
      this.messageVersions.delete(messageId);
      // Clean up token tracking state to prevent memory leaks
      this.tokenTracker.clearTokenState(messageId);
    }
    return didDelete;
  }
  private invalidateCache(): void {
    this.cache = {};
    this.updateRecency();
  }

  /**
   * Recompute and cache recency from current messages.
   * Called automatically when messages change.
   */
  private updateRecency(): void {
    const messages = this.getAllMessages();
    const messageRecency = computeRecencyTimestamp(messages, this.createdAt, this.unarchivedAt);
    const candidates = [messageRecency, this.lastResponseCompletedAt].filter(
      (t): t is number => t !== null
    );
    this.recencyTimestamp = candidates.length > 0 ? Math.max(...candidates) : null;
  }

  /**
   * Get the current recency timestamp (O(1) accessor).
   * Used for workspace sorting by last user interaction.
   */
  getRecencyTimestamp(): number | null {
    return this.recencyTimestamp;
  }

  /**
   * Get the current TODO list.
   * Updated whenever todo_write succeeds.
   */
  getCurrentTodos(): TodoItem[] {
    return this.todoStore.get();
  }

  /**
   * Get the current set of agent-flagged Assisted Review hunks.
   * Updated whenever `review_pane_update` succeeds.
   */
  getAssistedReviewHunks(): AssistedReviewHunk[] {
    return this.reviewHunkStore.get();
  }

  /**
   * Get the current agent status.
   * Updated whenever status_set is called.
   * Persists after stream completion (unlike todos).
   */
  getAgentStatus(): AgentStatus | undefined {
    return this.agentStatusAdapter.get();
  }

  /**
   * Get the list of loaded skills for this workspace.
   * Updated whenever agent_skill_read succeeds.
   * Persists after stream completion (like agentStatus).
   * Returns a stable array reference for memoization (only changes when skills change).
   */
  getLoadedSkills(): LoadedSkill[] {
    return this.skillStore.getLoadedSkills();
  }

  /**
   * Get runtime skill load errors (agent_skill_read failures).
   * Errors are cleared for a skill when it later loads successfully.
   * Returns a stable array reference for memoization.
   */
  getSkillLoadErrors(): SkillLoadError[] {
    return this.skillStore.getSkillLoadErrors();
  }

  /**
   * Check if there's an executing ask_user_question tool awaiting user input.
   * Used to show "Awaiting your input" instead of "streaming..." in the UI.
   */
  hasAwaitingUserQuestion(): boolean {
    // Only treat the workspace as "awaiting input" when the *latest* displayed
    // message is an executing ask_user_question tool.
    //
    // This avoids false positives from stale historical partials if the user
    // continued the chat after skipping/canceling the questions.
    const displayed = this.getDisplayedMessages();
    const last = displayed[displayed.length - 1];

    if (last?.type !== "tool") {
      return false;
    }

    return last.toolName === "ask_user_question" && last.status === "executing";
  }

  /**
   * Extract compaction summary text from a completed assistant message.
   * Used when a compaction stream completes to get the summary for history replacement.
   * @param messageId The ID of the assistant message to extract text from
   * @returns The concatenated text from all text parts, or undefined if message not found
   */
  getCompactionSummary(messageId: string): string | undefined {
    const message = this.messages.get(messageId);
    if (!message) return undefined;

    // Concatenate all text parts (ignore tool calls and reasoning)
    return getTextPartContent(message.parts);
  }

  /**
   * Clean up stream-scoped state when stream ends (normally or abnormally).
   * Called by handleStreamEnd, handleStreamAbort, and handleStreamError.
   *
   * Clears:
   * - Active stream tracking (this.activeStreams)
   * - Transient agentStatus (from displayStatus) - restored to persisted value
   *
   * Preserves:
   * - currentTodos (incomplete lists stay visible; handleStreamEnd may clear fully completed lists)
   * - lastCompletedStreamStats - timing stats from this stream for display after completion
   */
  private cleanupStreamState(messageId: string): void {
    // Clear optimistic interrupt flag if this stream was being interrupted.
    // This handles cases where streams end normally or with errors (not just abort).
    if (this.interruptingMessageId === messageId) {
      this.interruptingMessageId = null;
    }

    // Capture timing stats before removing the stream context
    const context = this.activeStreams.get(messageId);
    if (context) {
      const endTime = Date.now();
      const message = this.messages.get(messageId);

      const cumulativeUsage = this.tokenTracker.getActiveStreamCumulativeUsage(messageId);

      this.statsService.recordCompletedStream({
        endTime,
        serverStartTime: context.serverStartTime,
        serverFirstTokenTime: context.serverFirstTokenTime,
        toolExecutionMs: context.toolExecutionMs,
        pendingToolStarts: context.pendingToolStarts.values(),
        model: context.model,
        mode: message?.metadata?.mode ?? context.mode,
        durationMsFromMetadata: message?.metadata?.duration,
        cumulativeUsage,
        metadataUsage: message?.metadata?.usage,
        translateServerTime: (serverTime) => this.translateServerTime(context, serverTime),
      });
    }

    this.activeStreams.delete(messageId);
    // Restore persisted status - clears transient displayStatus, preserves status_set values
    this.agentStatusAdapter.restorePersisted();
  }

  /**
   * Compact a message's parts array by merging adjacent text/reasoning parts.
   * Called when streaming ends to convert thousands of delta parts into single strings.
   * This reduces memory from O(deltas) small objects to O(content_types) merged objects.
   */

  /**
   * Extract the final response text from a message (text after the last tool call).
   * Used for notification body content.
   */
  private extractFinalResponseText(message: MuxMessage | undefined): string {
    if (!message) return "";
    const parts = message.parts;
    const lastToolIndex = parts.findLastIndex((part) => part.type === "dynamic-tool");
    const textPartsAfterTools = lastToolIndex >= 0 ? parts.slice(lastToolIndex + 1) : parts;
    return getTextPartContent(textPartsAfterTools).trim();
  }

  private compactMessageParts(message: MuxMessage): void {
    message.parts = mergeAdjacentParts(message.parts);
  }

  addMessage(message: MuxMessage): void {
    const normalizedMessage = normalizeMessageRouteProvider(message);
    const existing = this.messages.get(normalizedMessage.id);
    if (existing) {
      const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
      const incomingParts = Array.isArray(normalizedMessage.parts)
        ? normalizedMessage.parts.length
        : 0;

      // Prefer richer content when duplicates arrive (e.g., placeholder vs completed message)
      if (incomingParts < existingParts) {
        return;
      }
    }

    // Just store the message - backend assigns historySequence
    this.messages.set(normalizedMessage.id, normalizedMessage);
    this.markMessageDirty(normalizedMessage.id);
  }

  /**
   * Remove a message from the aggregator.
   * Used for dismissing ephemeral messages like /plan output.
   * Rebuilds detected links to remove any that only existed in the removed message.
   */
  removeMessage(messageId: string): void {
    if (this.deleteMessage(messageId)) {
      this.invalidateCache();
    }
  }

  /**
   * Load historical messages in batch, preserving their historySequence numbers.
   * This is more efficient than calling addMessage() repeatedly.
   *
   * @param messages - Historical messages to load
   * @param hasActiveStream - Whether there's an active stream in buffered events (for reconnection scenario)
   * @param opts.mode - "replace" clears existing state first, "append" merges into existing state
   * @param opts.skipDerivedState - Skip replaying messages into derived state when appending older history
   */
  loadHistoricalMessages(
    messages: MuxMessage[],
    hasActiveStream = false,
    opts?: { mode?: "replace" | "append"; skipDerivedState?: boolean }
  ): void {
    const mode = opts?.mode ?? "replace";

    if (mode === "replace") {
      // Clear existing state to prevent stale messages from persisting.
      this.messages.clear();
      this.displayedMessageCache.clear();
      this.messageVersions.clear();
      this.tokenTracker.clearAll();
      this.skillStore.clear();
      this.lastResponseCompletedAt = null;

      // Track the replay window's oldest sequence for reconnect cursors.
      let minSeq: number | null = null;
      for (const msg of messages) {
        const seq = msg.metadata?.historySequence;
        if (typeof seq === "number" && (minSeq === null || seq < minSeq)) {
          minSeq = seq;
        }
      }
      this.establishedOldestHistorySequence = minSeq;
    }

    const overwrittenMessageIds: string[] = [];
    const appliedMessages: MuxMessage[] = [];

    // Add/overwrite messages in the map
    for (const message of messages) {
      const normalizedMessage = normalizeMessageRouteProvider(message);
      const existing = mode === "append" ? this.messages.get(normalizedMessage.id) : undefined;

      if (existing) {
        const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
        const incomingParts = Array.isArray(normalizedMessage.parts)
          ? normalizedMessage.parts.length
          : 0;

        // Since-replay can include a stale boundary row for an active stream message while
        // richer in-memory parts already exist. Keep the richer message to avoid dropping
        // in-flight tool/text parts that filtered replay deltas may not resend.
        if (incomingParts < existingParts) {
          continue;
        }

        overwrittenMessageIds.push(normalizedMessage.id);
      }

      this.messages.set(normalizedMessage.id, normalizedMessage);
      appliedMessages.push(normalizedMessage);
    }

    if (mode === "append") {
      for (const messageId of overwrittenMessageIds) {
        // Append replay can overwrite an existing message ID (e.g., partial -> finalized).
        // Bump per-message version so displayed row caches are invalidated and rebuilt.
        this.bumpMessageVersion(messageId);
        this.displayedMessageCache.delete(messageId);
      }
    }

    // Sort applied messages in chronological order for processing
    const chronologicalMessages = [...appliedMessages].sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );

    let shouldClearCompletedTodosOnIdleReplay = false;
    if (!opts?.skipDerivedState) {
      // Replay historical messages in order to reconstruct derived state
      for (const message of chronologicalMessages) {
        this.skillStore.maybeTrackLoadedSkillFromAgentSkillSnapshot(message.metadata?.agentSkillSnapshot);

        if (message.role === "user") {
          // Mirror live behavior for status: clear transient status on new user turn
          // but keep persisted status for fallback on reload.
          this.agentStatusAdapter.clearTransient();
          continue;
        }

        if (message.role === "assistant") {
          let assistantUpdatedTodos = false;
          for (const part of message.parts) {
            if (isDynamicToolPart(part) && part.state === "output-available") {
              // Replay deliberately omits the timestamp so historical
              // assisted-review pins don't all light up as "new" on initial
              // load; only live updates get a fresh addedAt.
              this.processToolResult(part.toolName, part.input, part.output);
              if (
                part.toolName === "todo_write" &&
                hasSuccessResult(part.output) &&
                parseTodoWriteInput(part.input)
              ) {
                assistantUpdatedTodos = true;
              }
            }
          }

          if (!hasActiveStream && assistantUpdatedTodos) {
            shouldClearCompletedTodosOnIdleReplay = message.metadata?.partial !== true;
          }
        }
      }
    }

    // If history was compacted away from the last status_set, fall back to persisted status
    this.agentStatusAdapter.restorePersistedIfEmpty();

    // Mirror live stream-end cleanup for idle reloads: a completed plan should not reappear
    // just because we reconstructed it from historical tool output after a successful final stream.
    if (
      !opts?.skipDerivedState &&
      !hasActiveStream &&
      this.activeStreams.size === 0 &&
      shouldClearCompletedTodosOnIdleReplay
    ) {
      this.todoStore.clearIfAllCompleted();
    }

    this.invalidateCache();

    if (!opts?.skipDerivedState && !hasActiveStream && this.pendingStreamStartTime !== null) {
      const latestMessage = this.getAllMessages().at(-1);
      const historySettledThePendingTurn =
        latestMessage?.role === "assistant" ||
        (latestMessage?.role === "user" && this.optimisticPendingStreamStart) ||
        (latestMessage == null && !this.optimisticPendingStreamStart);
      if (historySettledThePendingTurn) {
        // User rationale: optimistic startup for a brand-new chat should survive an
        // empty caught-up cycle, but once history shows the first turn (or an assistant
        // response), the normal transcript can take over and the local barrier should end.
        this.clearPendingStreamLifecycleState();
      }
    }
  }

  setEstablishedOldestHistorySequence(sequence: number | null): void {
    this.establishedOldestHistorySequence = sequence;
  }

  getAllMessages(): MuxMessage[] {
    this.cache.allMessages ??= Array.from(this.messages.values()).sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );
    return this.cache.allMessages;
  }

  /**
   * Build a cursor for incremental onChat reconnection.
   * Returns undefined when we cannot safely represent the current state,
   * forcing a full replay.
   */
  getOnChatCursor(): OnChatCursor | undefined {
    let maxHistorySequence = -1;
    let maxHistoryMessageId: string | undefined;
    let minHistorySequence = Number.POSITIVE_INFINITY;

    for (const message of this.messages.values()) {
      const historySequence = message.metadata?.historySequence;
      if (historySequence === undefined) {
        continue;
      }

      if (historySequence > maxHistorySequence) {
        maxHistorySequence = historySequence;
        maxHistoryMessageId = message.id;
      }

      if (historySequence < minHistorySequence) {
        minHistorySequence = historySequence;
      }
    }

    if (!maxHistoryMessageId || !Number.isFinite(minHistorySequence)) {
      return undefined;
    }

    if (this.activeStreams.size > 1) {
      // Defensive fallback: multiple active streams is anomalous, so force a full replay.
      return undefined;
    }

    const allMessages = this.getAllMessages();
    const establishedOldestHistorySequence = this.establishedOldestHistorySequence;
    const fingerprintMessages =
      establishedOldestHistorySequence != null
        ? allMessages.filter(
            (message) =>
              (message.metadata?.historySequence ?? Number.POSITIVE_INFINITY) >=
              establishedOldestHistorySequence
          )
        : allMessages;

    // Scope fingerprint input to the established replay window. The server computes
    // priorHistoryFingerprint from getHistoryFromLatestBoundary(skip=0), so client-
    // paginated rows from older compaction epochs must be excluded to avoid false
    // mismatches that force unnecessary full replay on reconnect.
    const priorHistoryFingerprint = computePriorHistoryFingerprint(
      fingerprintMessages,
      maxHistorySequence
    );
    const oldestHistorySequence = establishedOldestHistorySequence ?? minHistorySequence;

    const cursor: OnChatCursor = {
      history: {
        messageId: maxHistoryMessageId,
        historySequence: maxHistorySequence,
        oldestHistorySequence,
        ...(priorHistoryFingerprint !== undefined ? { priorHistoryFingerprint } : {}),
      },
    };

    if (this.activeStreams.size === 1) {
      const activeStreamEntry = this.activeStreams.entries().next().value;
      assert(activeStreamEntry, "activeStreams size reported 1 but no entry found");
      const [messageId, context] = activeStreamEntry;
      cursor.stream = {
        messageId,
        lastTimestamp: context.lastServerTimestamp,
      };
    }

    return cursor;
  }
  // Efficient methods to check message state without creating arrays
  getMessageCount(): number {
    return this.messages.size;
  }

  hasMessages(): boolean {
    return this.messages.size > 0;
  }

  clearLastAbortReason(): void {
    this.lastAbortReason = null;
  }
  getLastAbortReason(): StreamAbortReasonSnapshot | null {
    return this.lastAbortReason;
  }

  getStreamLifecycle(): StreamLifecycleSnapshot | null {
    return this.streamLifecycle;
  }

  getPendingStreamStartTime(): number | null {
    return this.pendingStreamStartTime;
  }

  /**
   * Get the current pre-stream startup status.
   * Returns null if no startup breadcrumb is active.
   */
  getRuntimeStatus(): RuntimeStatusEvent | null {
    return this.runtimeStatus;
  }

  handleStreamLifecycle(event: StreamLifecycleEvent): void {
    this.streamLifecycle = copyStreamLifecycleSnapshot(event);

    if (event.phase === "interrupted" && event.abortReason) {
      this.lastAbortReason = {
        reason: event.abortReason,
        at: Date.now(),
      };
      return;
    }

    this.lastAbortReason = null;
  }

  private clearInFlightStreamLifecycle(): void {
    if (
      this.streamLifecycle?.phase === "preparing" ||
      this.streamLifecycle?.phase === "streaming" ||
      this.streamLifecycle?.phase === "completing"
    ) {
      this.streamLifecycle = null;
    }
  }

  /**
   * Handle runtime-status event.
   * Used to show both runtime readiness and generic startup breadcrumbs in StreamingBarrier.
   */
  handleRuntimeStatus(status: RuntimeStatusEvent): void {
    // Keep stream lifecycle code focused on when runtime status becomes irrelevant.
    if (status.phase === "ready" || status.phase === "error") {
      this.clearRuntimeStatus();
      return;
    }

    this.runtimeStatus = status;
  }

  private clearRuntimeStatus(): void {
    this.runtimeStatus = null;
  }

  private clearPendingStreamLifecycleState(): void {
    this.setPendingStreamStartTime(null);
    this.clearRuntimeStatus();
  }

  getPendingStreamModel(): string | null {
    if (this.pendingStreamStartTime === null) return null;
    return this.pendingStreamModel;
  }

  markOptimisticPendingStreamStart(model: string | null): void {
    this.optimisticPendingStreamStart = true;
    this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    this.pendingCompactionRequest = null;
    this.pendingStreamModel = model;
    this.setPendingStreamStartTime(Date.now());
  }

  clearPendingStreamStartIfNotOptimistic(): void {
    if (!this.optimisticPendingStreamStart) {
      this.clearPendingStreamStart();
      return;
    }

    // Preserve exactly one authoritative idle caught-up cycle for a just-created workspace.
    // If the server later still reports no active stream and no replayed turn has arrived,
    // the optimistic startup barrier is stale and should clear so recovery UI can reappear.
    if (this.optimisticPendingStreamStartIdleCaughtUpCount > 0) {
      this.clearPendingStreamStart();
      return;
    }

    this.optimisticPendingStreamStartIdleCaughtUpCount += 1;
  }

  private getLatestHistoricalCompactionRequest(): PendingCompactionRequest | null {
    let sawCompletedCompaction = false;
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && this.isCompactionBoundaryMessage(message)) {
        // A completed summary closes the earlier /compact request, so later auto-continue
        // streams must not inherit a stale "compacting" UI state from that older turn.
        sawCompletedCompaction = true;
        continue;
      }
      if (message.role !== "user") continue;
      const muxMetadata = message.metadata?.muxMetadata;
      if (muxMetadata?.type === "compaction-request") {
        return sawCompletedCompaction
          ? null
          : {
              parsed: muxMetadata.parsed,
              source: muxMetadata.source,
            };
      }
      return null;
    }

    return null;
  }

  private getLatestUnresolvedCompactionRequest(): PendingCompactionRequest | null {
    return this.pendingCompactionRequest ?? this.getLatestHistoricalCompactionRequest();
  }

  private resolveStreamStartCompaction(data: StreamStartEvent): boolean {
    // Keep stream classification separate from stream context construction so
    // continue turns after /compact do not inherit stale UI state from history.
    const streamSignalsCompaction = data.agentId === "compact" || data.mode === "compact";
    if (!streamSignalsCompaction && data.agentId != null) {
      return false;
    }

    return streamSignalsCompaction || this.getLatestUnresolvedCompactionRequest() !== null;
  }

  private isDefaultPostCompactionContinueTurn(): boolean {
    const messages = this.getAllMessages();
    const latestMessage = messages.at(-1);
    const previousMessage = messages.at(-2);
    if (latestMessage?.role !== "user" || previousMessage?.role !== "assistant") {
      return false;
    }

    if (latestMessage.metadata?.synthetic !== true) {
      return false;
    }

    const summaryMetadata = previousMessage.metadata?.muxMetadata;
    if (!isCompactionSummaryMetadata(summaryMetadata)) {
      return false;
    }

    // The backend marks internal post-compaction resumes at the compaction follow-up
    // source. This frontend check preserves the policy for replay/tests where only
    // the synthetic user row and compaction summary are available.
    return summaryMetadata.pendingFollowUp?.dispatchOptions?.source === "internal-resume";
  }

  private setPendingStreamStartTime(time: number | null): void {
    this.pendingStreamStartTime = time;
    if (time === null) {
      this.pendingCompactionRequest = null;
      this.pendingStreamModel = null;
      this.optimisticPendingStreamStart = false;
      this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    }
  }

  private getActiveMainStreamEntry(): [string, StreamingContext] | undefined {
    for (const entry of this.activeStreams) {
      const [messageId] = entry;
      // /btw side-answer streams render through the same event channel but do
      // not belong to StreamManager. Active-stream callers such as interrupt,
      // live usage, and stats must keep pointing at the real main-agent stream.
      if (!this.isSideQuestionAnswerMessage(messageId)) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Get timing statistics for the active stream (if any).
   * Returns null if no active stream exists.
   * Includes live token count and TPS for real-time display.
   */
  getActiveStreamTimingStats(): {
    startTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    /** Live token count from streaming deltas */
    liveTokenCount: number;
    /** Live tokens-per-second (trailing window) */
    liveTPS: number;
    /** Mode (plan/exec) for this stream */
    mode?: string;
  } | null {
    const activeMainStream = this.getActiveMainStreamEntry();
    if (!activeMainStream) return null;
    const [messageId, context] = activeMainStream;

    const now = Date.now();

    const startTime = this.translateServerTime(context, context.serverStartTime);
    const firstTokenTime =
      context.serverFirstTokenTime !== null
        ? this.translateServerTime(context, context.serverFirstTokenTime)
        : null;

    // Include time from currently-executing tools (not just completed ones)
    let totalToolMs = context.toolExecutionMs;
    for (const toolStartServerTime of context.pendingToolStarts.values()) {
      const toolStartTime = this.translateServerTime(context, toolStartServerTime);
      totalToolMs += Math.max(0, now - toolStartTime);
    }

    return {
      startTime,
      firstTokenTime,
      toolExecutionMs: totalToolMs,
      model: context.model,
      liveTokenCount: this.tokenTracker.getStreamingTokenCount(messageId),
      liveTPS: this.tokenTracker.getStreamingTPS(messageId),
      mode: context.mode,
    };
  }

  /**
   * Get timing statistics from the last completed stream.
   * Returns null if no stream has completed yet in this session.
   * Unlike getActiveStreamTimingStats, this includes endTime and token counts.
   */
  getLastCompletedStreamStats(): {
    startTime: number;
    endTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    outputTokens: number;
    reasoningTokens: number;
    streamingMs: number;
    mode?: string;
  } | null {
    return this.statsService.getLastCompletedStreamStats();
  }

  /**
   * Get aggregate timing statistics across all completed streams in this session.
   * Totals are computed on-the-fly from per-model data.
   * Returns null if no streams have completed yet.
   *
   * Session timing keys use format "model" or "model:mode" (e.g., "claude-opus-4:plan").
   * The byModelAndMode map preserves this structure for mode breakdown display.
   */
  getSessionTimingStats(): {
    totalDurationMs: number;
    totalToolExecutionMs: number;
    totalStreamingMs: number;
    averageTtftMs: number | null;
    responseCount: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    /** Per-model timing breakdown (keys are composite: "model" or "model:mode") */
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
        /** Mode extracted from composite key, undefined for old data */
        mode?: string;
      }
    >;
  } | null {
    return this.statsService.getSessionTimingStats();
  }

  getActiveStreams(): StreamingContext[] {
    return Array.from(this.activeStreams.values());
  }

  getActiveResponseCompleteMetadata() {
    return (
      buildAggregateResponseCompleteMetadata(this.activeStreams.values()) ??
      this.backgroundHandoffCompletion
    );
  }

  handleBackgroundStreamingGenerationAdvance(): void {
    const completion = buildAggregateResponseCompleteMetadata(this.activeStreams.values());
    this.backgroundHandoffCompletion =
      completion?.suppressNotification === true ? completion : undefined;
    this.clearActiveStreams();
  }

  clearBackgroundHandoffCompletion(): void {
    this.backgroundHandoffCompletion = undefined;
  }

  setActiveQueuedFollowUp(hasQueuedFollowUp: boolean): void {
    for (const context of this.activeStreams.values()) {
      context.hasQueuedFollowUp = hasQueuedFollowUp;
    }
  }

  /**
   * Get the active main-agent stream id (for interrupt, live usage, and token tracking).
   * Returns undefined when no interruptible main-agent stream is active.
   */
  getActiveStreamMessageId(): string | undefined {
    return this.getActiveMainStreamEntry()?.[0];
  }

  /**
   * Mark the current active stream as "interrupting" (transient state).
   * Called before interruptStream so UI shows "interrupting..." immediately.
   * Cleared when real stream-abort arrives, at which point "interrupted" shows.
   */
  setInterrupting(): void {
    const activeMessageId = this.getActiveStreamMessageId();
    if (activeMessageId) {
      this.interruptingMessageId = activeMessageId;
      this.invalidateCache();
    }
  }

  /**
   * Check if a message is in the "interrupting" transient state.
   */
  isInterrupting(messageId: string): boolean {
    return this.interruptingMessageId === messageId;
  }

  /**
   * Check if any stream is currently being interrupted.
   */
  hasInterruptingStream(): boolean {
    return this.interruptingMessageId !== null;
  }

  isCompacting(): boolean {
    for (const context of this.activeStreams.values()) {
      if (context.isCompacting) {
        return true;
      }
    }
    return false;
  }

  /** Is the /btw side-question pipeline currently streaming an answer? */
  isSideQuestionStreaming(): boolean {
    for (const messageId of this.activeStreams.keys()) {
      if (this.isSideQuestionAnswerMessage(messageId)) {
        return true;
      }
    }
    return false;
  }

  /** Active streams that can be interrupted via the backend StreamManager. */
  hasInterruptibleActiveStream(): boolean {
    return this.getActiveMainStreamEntry() !== undefined;
  }

  /** Is `messageId` a /btw side-question answer? */
  isSideQuestionAnswerMessage(messageId: string): boolean {
    const message = this.messages.get(messageId);
    return message !== undefined && isSideQuestionAnswerMuxMessage(message);
  }

  private isSideQuestionAnswerStreamEvent(event: {
    messageId: string;
    metadata?: { muxMetadata?: unknown };
  }): boolean {
    if (this.isSideQuestionAnswerMessage(event.messageId)) {
      return true;
    }

    const muxMetadata = event.metadata?.muxMetadata;
    return (
      typeof muxMetadata === "object" &&
      muxMetadata !== null &&
      "type" in muxMetadata &&
      muxMetadata.type === SIDE_QUESTION_ANSWER_METADATA_TYPE
    );
  }

  getCurrentModel(): string | undefined {
    // If there's an active main-agent stream, return its model. /btw streams
    // are read-only asides and must not become the workspace's current model.
    for (const [messageId, context] of this.activeStreams) {
      if (!this.isSideQuestionAnswerMessage(messageId)) {
        return context.model;
      }
    }

    // Otherwise, return the model from the most recent non-side-answer assistant message.
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === "assistant" &&
        !isSideQuestionAnswerMuxMessage(message) &&
        message.metadata?.model
      ) {
        return message.metadata.model;
      }
    }

    return undefined;
  }

  /**
   * Returns the effective thinking level for the current or most recent stream.
   * This reflects the actual level used after model policy clamping, not the
   * user-configured level.
   */
  getCurrentThinkingLevel(): string | undefined {
    // If there's an active main-agent stream, return its thinking level.
    // /btw streams are read-only asides and must not become workspace state.
    for (const [messageId, context] of this.activeStreams) {
      if (!this.isSideQuestionAnswerMessage(messageId)) {
        return context.thinkingLevel;
      }
    }

    // Only check the most recent non-side-answer assistant message to avoid
    // returning stale values from older turns where settings may have differed.
    // If it lacks thinkingLevel (e.g. error/abort), return undefined so
    // callers fall back to localStorage.
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && !isSideQuestionAnswerMuxMessage(message)) {
        return message.metadata?.thinkingLevel;
      }
    }

    return undefined;
  }

  clearActiveStreams(): void {
    const activeMessageIds = Array.from(this.activeStreams.keys());
    this.activeStreams.clear();

    // Clear optimistic interrupt flag since all streams are cleared
    this.interruptingMessageId = null;

    if (activeMessageIds.length > 0) {
      for (const messageId of activeMessageIds) {
        this.bumpMessageVersion(messageId);
      }
      this.invalidateCache();
    }
  }

  /**
   * Replay-visible init output needs a synchronous cache flush. WorkspaceStore can
   * bump subscribers before the normal 100ms init-output throttle fires, and in
   * reconnects that would otherwise leave the newest line hidden until caught-up.
   */
  flushPendingInitOutput(): void {
    this.initStateHandler.flushPendingOutput();
  }

  clearPendingStreamStart(): void {
    this.setPendingStreamStartTime(null);
  }

  resetForReplay(): void {
    const pendingStreamSnapshot =
      this.pendingStreamStartTime === null
        ? null
        : {
            pendingStreamStartTime: this.pendingStreamStartTime,
            pendingCompactionRequest: this.pendingCompactionRequest,
            pendingStreamModel: this.pendingStreamModel,
            optimisticPendingStreamStart: this.optimisticPendingStreamStart,
            optimisticPendingStreamStartIdleCaughtUpCount:
              this.optimisticPendingStreamStartIdleCaughtUpCount,
          };

    this.clear();

    if (!pendingStreamSnapshot) {
      return;
    }

    this.pendingStreamStartTime = pendingStreamSnapshot.pendingStreamStartTime;
    this.pendingCompactionRequest = pendingStreamSnapshot.pendingCompactionRequest;
    this.pendingStreamModel = pendingStreamSnapshot.pendingStreamModel;
    this.optimisticPendingStreamStart = pendingStreamSnapshot.optimisticPendingStreamStart;
    this.optimisticPendingStreamStartIdleCaughtUpCount =
      pendingStreamSnapshot.optimisticPendingStreamStartIdleCaughtUpCount;
  }

  clear(): void {
    this.messages.clear();
    this.activeStreams.clear();
    this.displayedMessageCache.clear();
    this.messageVersions.clear();
    this.clearPendingStreamLifecycleState();
    this.interruptingMessageId = null;
    this.streamLifecycle = null;
    this.lastAbortReason = null;
    this.lastResponseCompletedAt = null;
    this.establishedOldestHistorySequence = null;
    this.invalidateCache();
  }

  /**
   * Remove messages with specific historySequence numbers
   * Used when backend truncates history
   */
  handleDeleteMessage(deleteMsg: DeleteMessage): void {
    const sequencesToDelete = new Set(deleteMsg.historySequences);

    // Remove messages that match the historySequence numbers
    for (const [messageId, message] of this.messages.entries()) {
      const historySeq = message.metadata?.historySequence;
      if (historySeq !== undefined && sequencesToDelete.has(historySeq)) {
        this.deleteMessage(messageId);
      }
    }

    this.invalidateCache();
  }

  // Unified event handlers that encapsulate all complex logic
  handleStreamStart(data: StreamStartEvent): void {
    const isCompacting = this.resolveStreamStartCompaction(data);
    const isSideQuestionAnswerStream = this.isSideQuestionAnswerStreamEvent(data);

    // Clear pending "starting..." UI once a main-agent turn is live. /btw
    // side-answer streams can start while a normal turn is still waiting for
    // its own stream-start, so they must not hide the main startup barrier.
    if (!isSideQuestionAnswerStream) {
      this.clearPendingStreamLifecycleState();
      this.lastAbortReason = null;
    }

    // NOTE: We do NOT clear agentStatus or currentTodos here.
    // They are cleared when a new user message arrives (see handleMessage),
    // ensuring consistent behavior whether loading from history or processing live events.

    if (!isSideQuestionAnswerStream) {
      for (const activeStream of this.activeStreams.values()) {
        // A queued follow-up belongs to the handoff into the next main stream.
        // /btw side-answer streams are independent asides, so they must not
        // clear the main stream's queued-follow-up suppression state.
        activeStream.hasQueuedFollowUp = false;
      }
      this.backgroundHandoffCompletion = undefined;
    }
    const routeProvider = resolveRouteProvider(data.routeProvider, data.routedThroughGateway);

    const suppressNotification =
      this.isDefaultPostCompactionContinueTurn() ||
      this.getLatestUnresolvedCompactionRequest()?.parsed.followUpContent?.dispatchOptions
        ?.source === "internal-resume";
    const now = Date.now();
    const context: StreamingContext = {
      serverStartTime: data.startTime,
      clockOffsetMs: now - data.startTime,
      lastServerTimestamp: data.startTime,
      isComplete: false,
      isCompacting,
      hasQueuedFollowUp: false,
      suppressNotification,
      isReplay: data.replay === true,
      model: data.model,
      routedThroughGateway: data.routedThroughGateway,
      routeProvider,
      serverFirstTokenTime: null,
      toolExecutionMs: 0,
      pendingToolStarts: new Map(),
      agentId: data.agentId,
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
    };

    // For incremental replay: stream-start may be re-emitted to re-establish context.
    // If we already have this message with accumulated parts, don't wipe its content.
    const existingMessage = this.messages.get(data.messageId);
    const existingContext = this.activeStreams.get(data.messageId);
    if (data.replay && existingMessage && existingMessage.parts.length > 0) {
      if (existingContext) {
        // Preserve the highest observed server timestamp across reconnect boundaries.
        // If replay emits only stream-start (no newer parts), regressing this value
        // would cause the next since cursor to request already-seen stream events.
        context.lastServerTimestamp = Math.max(
          context.lastServerTimestamp,
          existingContext.lastServerTimestamp
        );
        context.clockOffsetMs = Date.now() - context.lastServerTimestamp;

        context.agentId = data.agentId ?? existingContext.agentId;

        // Preserve in-flight timing context so reconnect doesn't reset active tool timing stats.
        context.serverFirstTokenTime = existingContext.serverFirstTokenTime;
        context.toolExecutionMs = existingContext.toolExecutionMs;
        context.pendingToolStarts = new Map(existingContext.pendingToolStarts);
      }

      this.activeStreams.set(data.messageId, context);
      if (existingMessage.metadata) {
        existingMessage.metadata.model = data.model;
        existingMessage.metadata.routedThroughGateway = data.routedThroughGateway;
        existingMessage.metadata.routeProvider = routeProvider;
        if (data.agentId != null) {
          existingMessage.metadata.agentId = data.agentId;
        }
        existingMessage.metadata.mode = data.mode;
        existingMessage.metadata.thinkingLevel = data.thinkingLevel;
      }
      this.markMessageDirty(data.messageId);
      return;
    }

    // Use messageId as key - ensures only ONE stream per message
    // If called twice, second call safely overwrites first
    this.activeStreams.set(data.messageId, context);

    // Carry forward any muxMetadata that was attached when the message was
    // first seen (e.g., the side-question pipeline emits a placeholder
    // `message` event with `muxMetadata.type === "side-question-answer"`
    // immediately before this stream-start). Without this, the fresh
    // createMuxMessage below would silently drop the marker for the
    // duration of the stream — breaking the "side answer" badge and the
    // /btw split rendering, both of which key off this metadata when
    // `buildDisplayedMessagesForMessage` runs.
    const carriedMuxMetadata = existingMessage?.metadata?.muxMetadata;

    // Create initial streaming message with empty parts (deltas will append)
    const streamingMessage = createMuxMessage(data.messageId, "assistant", "", {
      historySequence: data.historySequence,
      timestamp: Date.now(),
      model: data.model,
      routedThroughGateway: data.routedThroughGateway,
      routeProvider,
      agentId: data.agentId,
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
      ...(carriedMuxMetadata !== undefined ? { muxMetadata: carriedMuxMetadata } : {}),
    });

    this.messages.set(data.messageId, streamingMessage);
    this.markMessageDirty(data.messageId);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (only for non-empty deltas)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Compact-on-append: when the previous part is text (the common case during
    // a text run), append into it in place instead of growing parts unbounded.
    // For a 10k-char reply this drops parts.length from thousands to one and
    // shrinks per-render mergeAdjacentParts cost from O(N) to O(1). The on-disk
    // format is unaffected — partial.json/chat.jsonl persistence happens
    // backend-side; this aggregator's parts are pure in-memory display state.
    const lastPart = message.parts[message.parts.length - 1];
    if (lastPart?.type === "text") {
      lastPart.text += data.delta;
    } else {
      message.parts.push({
        type: "text",
        text: data.delta,
        timestamp: data.timestamp,
      });
    }

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "text");

    this.markMessageDirty(data.messageId);
  }

  handleStreamEnd(data: StreamEndEvent): void {
    const isSideQuestionAnswerStream = this.isSideQuestionAnswerStreamEvent(data);
    // A terminal event for the main agent means any locally preserved
    // "starting..." state is stale, even if reconnect delivered stream-end
    // without the earlier stream-start. /btw side-answer streams are separate
    // and must not hide a still-pending main startup barrier.
    if (!isSideQuestionAnswerStream) {
      this.clearPendingStreamLifecycleState();
    }

    // Direct lookup by messageId - O(1) instead of O(n) find
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Normal streaming case: we've been tracking this stream from the start
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        // Transparent metadata merge - backend fields flow through automatically
        const updatedMetadata: MuxMetadata = {
          ...message.metadata,
          ...data.metadata,
        };
        updatedMetadata.routeProvider = resolveRouteProvider(
          updatedMetadata.routeProvider,
          updatedMetadata.routedThroughGateway
        );

        const durationMs = data.metadata.duration;
        if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
          this.updateStreamClock(activeStream, activeStream.serverStartTime + durationMs);
        }
        message.metadata = updatedMetadata;

        // Update tool parts with their results if provided
        if (data.parts) {
          // Sync up the tool results from the backend's parts array
          for (const backendPart of data.parts) {
            if (backendPart.type === "dynamic-tool" && backendPart.state === "output-available") {
              const toolPartIndex = message.parts.findIndex(
                (part) => part.type === "dynamic-tool" && part.toolCallId === backendPart.toolCallId
              );
              const toolPart = message.parts[toolPartIndex];
              if (toolPart?.type === "dynamic-tool") {
                // Replace the discriminated-union member instead of mutating its
                // discriminator in place; this keeps TypeScript and runtime shape aligned.
                message.parts[toolPartIndex] = {
                  ...toolPart,
                  state: "output-available",
                  output: backendPart.output,
                };
              }
            }
          }
        }

        // Compact parts to merge adjacent text/reasoning deltas into single strings
        // This reduces memory from thousands of small delta objects to a few merged objects
        this.compactMessageParts(message);
      }

      // Capture completion metadata before cleanup (cleanup removes the stream context).
      // If another turn is already queued, this stream end is only an intermediate handoff.
      const completion = buildResponseCompleteMetadata(activeStream);

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);

      const isFinal = this.getActiveMainStreamEntry() === undefined;

      // Completion timestamp for final main-agent streams — the "stream ended"
      // fact. Side answers can overlap with the main stream but should not
      // suppress the main final completion or emit replacement notifications.
      const completedAt = isFinal && !isSideQuestionAnswerStream ? Date.now() : null;

      // Recency policy: only non-compaction main finals inflate lastResponseCompletedAt.
      // Compaction recency comes from the compacted summary's own timestamp.
      if (completedAt !== null && !activeStream.isCompacting) {
        this.lastResponseCompletedAt = completedAt;
      }

      // Notify on normal stream completion (skip replay-only reconstruction and
      // /btw side-answer streams).
      // isFinal = true when the main agent is done with all work.
      if (this.workspaceId && this.onResponseComplete && !isSideQuestionAnswerStream) {
        this.onResponseComplete({
          workspaceId: this.workspaceId,
          messageId: data.messageId,
          isFinal,
          finalText: this.extractFinalResponseText(message),
          completion,
          completedAt,
        });
      }
    } else {
      // Reconnection case: user reconnected after stream completed
      // We reconstruct the entire message from the stream-end event
      // The backend now sends us the parts array with proper temporal ordering
      // Backend MUST provide historySequence in metadata

      // Create the complete message
      const routeProvider = resolveRouteProvider(
        data.metadata.routeProvider,
        data.metadata.routedThroughGateway
      );
      const message: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        metadata: {
          ...data.metadata,
          routeProvider,
          timestamp: data.metadata.timestamp ?? Date.now(),
        },
        parts: data.parts,
      };

      this.messages.set(data.messageId, message);

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
    }
    // Keep incomplete plans available across stream boundaries, but clear a fully completed
    // plan once the workspace has no active streams so finished work does not linger.
    if (this.activeStreams.size === 0) {
      this.todoStore.clearIfAllCompleted();
    }

    // Assistant message is now stable (completed or reconnected) - invalidate all caches.
    this.markMessageDirty(data.messageId);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    // Abort can arrive before stream-start. Clear pending lifecycle UI immediately.
    this.clearPendingStreamLifecycleState();
    this.clearInFlightStreamLifecycle();
    this.lastAbortReason = {
      reason: data.abortReason ?? "system",
      at: Date.now(),
    };

    // Clear "interrupting" state - stream is now fully "interrupted"
    if (this.interruptingMessageId === data.messageId) {
      this.interruptingMessageId = null;
    }

    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message as interrupted and merge metadata (consistent with handleStreamEnd)
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata = {
          ...message.metadata,
          partial: true,
          ...data.metadata, // Spread abort metadata (usage, duration)
        };

        // Compact parts even on abort - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
      // Assistant message is now stable (aborted) - invalidate all caches.
      this.markMessageDirty(data.messageId);
    }
  }

  handleStreamError(data: StreamErrorMessage): void {
    // Error can arrive before/instead of stream-start. Clear pending lifecycle UI immediately.
    this.clearPendingStreamLifecycleState();
    this.clearInFlightStreamLifecycle();

    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message with error metadata
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata.partial = true;
        message.metadata.error = data.error;
        message.metadata.errorType = data.errorType;

        // Compact parts even on error - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
      // Assistant message is now stable (errored) - invalidate all caches.
      this.markMessageDirty(data.messageId);
    } else {
      const existingMessage = this.messages.get(data.messageId);
      if (existingMessage?.role === "assistant" && existingMessage.metadata) {
        existingMessage.metadata.partial = true;
        existingMessage.metadata.error = data.error;
        existingMessage.metadata.errorType = data.errorType;
        this.markMessageDirty(data.messageId);
        return;
      }

      // Pre-stream error (e.g., API key not configured before streaming starts)
      // Create a synthetic error message since there's no active stream to attach to.
      // If replay re-emits the same terminal error later, preserve this message's metadata
      // instead of regenerating ordering fields that can churn append-replay state.
      const maxSequence = Math.max(
        0,
        ...Array.from(this.messages.values()).map((m) => m.metadata?.historySequence ?? 0)
      );
      const errorMessage: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        parts: [],
        metadata: {
          partial: true,
          error: data.error,
          errorType: data.errorType,
          timestamp: Date.now(),
          historySequence: maxSequence + 1,
        },
      };
      this.messages.set(data.messageId, errorMessage);
      this.markMessageDirty(data.messageId);
    }
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    // If this is a nested call (from PTC code_execution), add to parent's nestedCalls
    if (data.parentToolCallId) {
      const parentPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
      );
      if (parentPart) {
        // Initialize nestedCalls array if needed
        parentPart.nestedCalls ??= [];
        parentPart.nestedCalls.push({
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          state: "input-available",
          input: data.args,
          timestamp: data.timestamp,
        });
        this.markMessageDirty(data.messageId);
        return;
      }
    }

    // Check if this tool call already exists to prevent duplicates
    const existingToolPart = message.parts.find(
      (part): part is DynamicToolPart =>
        part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
    );

    if (existingToolPart) {
      console.warn(`Tool call ${data.toolCallId} already exists, skipping duplicate`);
      return;
    }

    // Track tool start time for execution duration calculation
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);
      context.pendingToolStarts.set(data.toolCallId, data.timestamp);
    }

    // Add tool part to maintain temporal order
    const toolPart: DynamicToolPartPending = {
      type: "dynamic-tool",
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      state: "input-available",
      input: data.args,
      timestamp: data.timestamp,
    };
    message.parts.push(toolPart);

    // Track tokens for tool input
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");

    this.markMessageDirty(data.messageId);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");
    // Tool deltas are for display - args are in dynamic-tool part
  }

  /**
   * Process a completed tool call's result to update derived state.
   * Called for both live tool-call-end events and historical tool parts.
   *
   * This is the single source of truth for updating state from tool results,
   * ensuring consistency whether processing live events or historical messages.
   *
   * @param toolName - Name of the tool that was called
   * @param input - Tool input arguments
   * @param output - Tool output result
   * @param messageContext - Optional metadata about the assistant message that
   *   owns this tool call. Used by `review_pane_update` to stamp each
   *   agent-flagged hunk with the originating turn's timestamp so the UI
   *   can render a "new since last update" badge for freshly-added pins.
   */
  private processToolResult(
    toolName: string,
    input: unknown,
    output: unknown,
    messageContext?: { timestamp?: number }
  ): void {
    // Update TODO state if this was a successful todo_write.
    // We still reconstruct from history so interrupted/incomplete plans survive reloads;
    // final completed plans are cleared later when the last active stream ends.
    if (toolName === "todo_write" && hasSuccessResult(output)) {
      this.todoStore.updateFromToolResult(input, output);
    }

    // Update Assisted Review state when review_pane_update succeeds.
    // The tool returns the resulting list directly (already merged + deduped
    // by the handler), so we just re-parse the formatted strings into our
    // structured AssistedReviewHunk form. Re-running this across the entire
    // history naturally reconstructs the final state on reload.
    //
    // We additionally carry `addedAt` per pin so the UI can render a
    // transient "new" badge for freshly-added pins.
    //
    // Carryover semantics:
    //   - `operation: "add"` — the agent is appending to or refining the
    //     existing set, so a previously-seen key keeps its original
    //     `addedAt`. This prevents an `add` that just tweaks a comment
    //     from re-arming the "new" badge.
    //   - `operation: "replace"` — the agent is republishing a fresh
    //     snapshot. Treat every entry as new for metadata purposes (the
    //     same key reappearing is an explicit re-flag, not a refinement),
    //     so the UI can re-highlight the snapshot.
    if (toolName === "review_pane_update") {
      this.reviewHunkStore.updateFromToolResult(output, messageContext);
    }

    if (toolName === "propose_plan" && hasSuccessResult(output)) {
      this.todoStore.completeInProgress();
    }

    // Update agent status if this was a successful status_set
    // agentStatus persists: update both during streaming and on historical reload
    // Use output instead of input to get the truncated message
    if (toolName === "status_set") {
      const result = parseStatusSetSuccessResult(output);
      if (result) {
        this.agentStatusAdapter.setStatusFromResult(result.emoji, result.message, result.url);
      }
    }

    // Handle browser notifications when Electron wasn't available
    if (toolName === "notify") {
      const result = parseNotifySuccessResult(output);
      if (result) {
        const uiOnlyNotify = getToolOutputUiOnly(output)?.notify;
        const legacyNotify = parseLegacyNotifyRouting(output);
        const notifiedVia = uiOnlyNotify?.notifiedVia ?? legacyNotify?.notifiedVia;
        const workspaceId = uiOnlyNotify?.workspaceId ?? legacyNotify?.workspaceId;

        if (notifiedVia === "browser") {
          this.sendBrowserNotification(result.title, result.message, workspaceId);
        }
      }
    }

    if (toolName === "agent_skill_read") {
      // Keep agent_skill_read parsing separate so this router only decides *which*
      // derived-state handler should run for a tool result.
      this.skillStore.handleAgentSkillReadResult(input, output);
    }

    // Link extraction is derived from message history (see computeLinksFromMessages()).
    // When a tool output becomes available, handleToolCallEnd invalidates the link cache.
  }

  /**
   * Send a browser notification using the Web Notifications API
   * Only called when Electron notifications are unavailable.
   * Clicking the notification navigates to the workspace.
   */
  private sendBrowserNotification(title: string, body?: string, workspaceId?: string): void {
    showBrowserNotification(title, {
      body,
      onClick: workspaceId
        ? () => {
            // Focus the window and navigate to the workspace.
            window.focus();
            this.onNavigateToWorkspace?.(workspaceId);
          }
        : undefined,
    });
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    // Track tool execution duration
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      const startTime = context.pendingToolStarts.get(data.toolCallId);
      if (startTime !== undefined) {
        // Clamp to non-negative to handle out-of-order timestamps during replay
        context.toolExecutionMs += Math.max(0, data.timestamp - startTime);
        context.pendingToolStarts.delete(data.toolCallId);
      }
    }

    const message = this.messages.get(data.messageId);
    if (message) {
      // If nested, update in parent's nestedCalls array
      if (data.parentToolCallId) {
        const parentIndex = message.parts.findIndex(
          (part): part is DynamicToolPart =>
            part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
        );
        const parentPart = message.parts[parentIndex] as DynamicToolPart | undefined;
        if (parentPart?.nestedCalls) {
          const nestedIndex = parentPart.nestedCalls.findIndex(
            (nc) => nc.toolCallId === data.toolCallId
          );
          if (nestedIndex !== -1) {
            // Create new objects to trigger React re-render (immutable update pattern)
            const updatedNestedCalls = parentPart.nestedCalls.map((nc, i) =>
              i === nestedIndex
                ? { ...nc, state: "output-available" as const, output: data.result }
                : nc
            );
            message.parts[parentIndex] = { ...parentPart, nestedCalls: updatedNestedCalls };
            this.markMessageDirty(data.messageId);
            return;
          }
        }
      }

      // Find the specific tool part by its ID and update it with the result.
      // We don't move it - it stays in its original temporal position.
      const toolPartIndex = message.parts.findIndex(
        (part) => part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
      );
      const toolPart = message.parts[toolPartIndex];
      if (toolPart?.type === "dynamic-tool") {
        message.parts[toolPartIndex] = {
          ...toolPart,
          state: "output-available",
          output: data.result,
        };

        // Process tool result to update derived state (todos, agentStatus, etc.)
        // Live updates stamp a fresh `Date.now()` so the Assisted-review "new"
        // badge can highlight just-introduced pins (the replay path
        // intentionally omits this so historical pins don't flash on load).
        this.processToolResult(data.toolName, toolPart.input, data.result, {
          timestamp: Date.now(),
        });

        // Tool output is now stable - invalidate all caches.
        this.markMessageDirty(data.messageId);
      } else {
        // Tool part not found (shouldn't happen normally) - still invalidate display cache.
        this.markMessageDirty(data.messageId);
      }
    }
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (reasoning also counts as first token)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Compact-on-append for reasoning runs (same rationale as handleStreamDelta).
    const lastPart = message.parts[message.parts.length - 1];
    if (lastPart?.type === "reasoning") {
      lastPart.text += data.delta;
    } else {
      message.parts.push({
        type: "reasoning",
        text: data.delta,
        timestamp: data.timestamp,
      });
    }

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "reasoning");

    this.markMessageDirty(data.messageId);
  }

  handleReasoningEnd(_data: ReasoningEndEvent): void {
    // Reasoning-end is just a signal - no state to update
    // Streaming status is inferred from activeStreams in getDisplayedMessages
    this.invalidateCache();
  }

  handleMessage(data: WorkspaceChatMessage): void {
    if (this.initStateHandler.shouldSkipReplayEvent(data)) {
      return;
    }

    if (this.initStateHandler.handleMessage(data)) {
      return;
    }

    if (isMuxMessage(data)) {
      this.handleMuxMessage(data);
    }
  }

  private handleMuxMessage(data: MuxMessage): void {
    const incomingMessage = normalizeMessageRouteProvider(data);

    // Smart replacement logic for edits: if history was truncated, remove the
    // existing message at the incoming sequence and all subsequent messages.
    const incomingSequence = incomingMessage.metadata?.historySequence;
    if (incomingSequence !== undefined) {
      for (const [_id, msg] of this.messages.entries()) {
        const existingSequence = msg.metadata?.historySequence;
        if (existingSequence !== undefined && existingSequence >= incomingSequence) {
          const messagesToRemove: string[] = [];
          for (const [removeId, removeMsg] of this.messages.entries()) {
            const removeSeq = removeMsg.metadata?.historySequence;
            if (removeSeq !== undefined && removeSeq >= incomingSequence) {
              messagesToRemove.push(removeId);
            }
          }
          for (const removeId of messagesToRemove) {
            this.deleteMessage(removeId);
          }
          break;
        }
      }
    }

    // When a compaction boundary arrives during a live session, prune messages
    // older than the incoming boundary sequence so the UI matches a fresh load
    // while older epochs remain available via Load More history pagination.
    if (this.isCompactionBoundaryMessage(incomingMessage)) {
      this.pruneBeforeLatestBoundary(incomingMessage);
    }

    this.addMessage(incomingMessage);
    this.skillStore.maybeTrackLoadedSkillFromAgentSkillSnapshot(incomingMessage.metadata?.agentSkillSnapshot);

    if (incomingMessage.role !== "user" || isSideQuestionUserMuxMessage(incomingMessage)) {
      return;
    }

    // Reset terminal lifecycle snapshots from the previous turn immediately so
    // the next accepted send never inherits a stale interrupted/failed state.
    this.streamLifecycle = null;

    const muxMeta = incomingMessage.metadata?.muxMetadata as
      | { displayStatus?: { emoji: string; message: string } }
      | undefined;
    const muxMetadata = incomingMessage.metadata?.muxMetadata;
    this.pendingCompactionRequest =
      muxMetadata?.type === "compaction-request"
        ? {
            parsed: muxMetadata.parsed,
            source: muxMetadata.source,
          }
        : null;

    this.optimisticPendingStreamStart = false;
    this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    this.pendingStreamModel = muxMetadata?.requestedModel ?? null;

    if (muxMeta?.displayStatus) {
      this.agentStatusAdapter.setTransient(muxMeta.displayStatus);
    } else {
      this.agentStatusAdapter.clearAll();
    }

    this.lastAbortReason = null;
    this.setPendingStreamStartTime(Date.now());
  }

  private isContextBoundaryMessage(message: MuxMessage): boolean {
    return (
      this.isCompactionBoundaryMessage(message) ||
      getContextBoundaryKind(message) === CONTEXT_BOUNDARY_KINDS.RESET
    );
  }

  private isCompactionBoundaryMessage(message: MuxMessage): boolean {
    const muxMeta = message.metadata?.muxMetadata;
    return (
      message.role === "assistant" &&
      (getContextBoundaryKind(message) === CONTEXT_BOUNDARY_KINDS.COMPACTION ||
        muxMeta?.type === "compaction-summary")
    );
  }

  /**
   * Keep only the latest epoch visible during a live session.
   *
   * When a new boundary arrives, existing messages still represent older epochs.
   * Prune every existing message with a lower sequence than the incoming boundary
   * so once the incoming boundary is appended, the transcript matches fresh loads
   * from getHistoryFromLatestBoundary(skip=0). Older epochs remain accessible via
   * Load More.
   */
  private pruneBeforeLatestBoundary(incomingBoundary: MuxMessage): void {
    const incomingBoundarySequence = incomingBoundary.metadata?.historySequence;
    // Self-healing guard: malformed boundary metadata should not crash live sessions.
    if (incomingBoundarySequence === undefined) return;

    // Live compaction advances the replay window floor to the incoming boundary.
    // Keep reconnect cursors aligned with the server's latest-boundary replay window
    // so incremental reconnects remain eligible after compaction.
    if (
      this.establishedOldestHistorySequence === null ||
      incomingBoundarySequence > this.establishedOldestHistorySequence
    ) {
      this.establishedOldestHistorySequence = incomingBoundarySequence;
    }

    const toRemove: string[] = [];
    for (const [id, msg] of this.messages.entries()) {
      const seq = msg.metadata?.historySequence;
      if (seq !== undefined && seq < incomingBoundarySequence) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.deleteMessage(id);
    }

    if (toRemove.length > 0) {
      this.invalidateCache();
    }
  }

  private buildDisplayedMessagesForMessage(
    message: MuxMessage,
    agentSkillSnapshot?: { frontmatterYaml?: string; body?: string },
    inlineSkillSnapshots?: InlineSkillSnapshotMap
  ): DisplayedMessage[] {
    return buildDisplayedMessagesForMessage({
      message,
      agentSkillSnapshot,
      inlineSkillSnapshots,
      hasActiveStream: this.activeStreams.has(message.id),
      streamIsReplay: this.activeStreams.get(message.id)?.isReplay,
      isContextBoundaryMessage: (candidate) => this.isContextBoundaryMessage(candidate),
    });
  }

  /**
   * After filtering older tool/reasoning parts, recompute which part is the
   * last visible block for each assistant message. This keeps meta rows and
   * interrupted barriers accurate after truncation.
   */
  private normalizeLastPartFlags(messages: DisplayedMessage[]): DisplayedMessage[] {
    const seenHistoryIds = new Set<string>();
    let didChange = false;
    const normalized = messages.slice();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!("isLastPartOfMessage" in msg) || typeof msg.historyId !== "string") {
        continue;
      }

      const shouldBeLast = !seenHistoryIds.has(msg.historyId);
      seenHistoryIds.add(msg.historyId);

      if (msg.isLastPartOfMessage !== shouldBeLast) {
        normalized[i] = { ...msg, isLastPartOfMessage: shouldBeLast };
        didChange = true;
      }
    }

    return didChange ? normalized : messages;
  }

  /**
   * Transform MuxMessages into DisplayedMessages for UI consumption
   * This splits complex messages with multiple parts into separate UI blocks
   * while preserving temporal ordering through sequence numbers
   *
   * IMPORTANT: Result is cached to ensure stable references for React.
   * Cache is invalidated whenever messages change (via invalidateCache()).
   */
  getDisplayedMessages(): DisplayedMessage[] {
    if (!this.cache.displayedMessages) {
      const displayedMessages: DisplayedMessage[] = [];
      const allMessages = this.getAllMessages();
      const showSyntheticMessages =
        typeof window !== "undefined" && window.api?.debugLlmRequest === true;

      const shouldHideMessageFromTranscript = (message: MuxMessage): boolean =>
        !showSyntheticMessages &&
        ((message.metadata?.synthetic === true && message.metadata?.uiVisible !== true) ||
          isWorkflowResultMessage(message));

      // Synthetic agent-skill snapshot messages are hidden from the transcript unless
      // debugLlmRequest is enabled. We still want to surface their content in the UI by
      // attaching the resolved snapshot (frontmatterYaml + body) to subsequent user
      // messages that reference skills via /{skillName} or inline $skillName tokens.
      const latestAgentSkillSnapshotByKey = new Map<string, AgentSkillSnapshotContent>();

      // ---------------------------------------------------------------
      // /btw side-question splitting:
      //
      // When a /btw fires WHILE a main-agent assistant message is mid-
      // stream, the backend stamps the user `/btw` row with
      // `interruptedMessageId` + `interruptedTextLength`. The frontend
      // uses those anchors to visually split the interrupted message so
      // the side branch appears between the pre-aside and post-aside
      // halves of the main agent's reply — without this, sequence-order
      // rendering would shove the side branch below the entire reply
      // (lower historySequence => higher in the transcript), defeating
      // the "main chat continues after the aside" UX.
      //
      // Build a placement plan before rendering any rows. Anchored /btw rows
      // are owned by the interrupted assistant's split output; stale or
      // standalone /btw rows render chronologically and cannot become split
      // children later in the same pass.
      // ---------------------------------------------------------------
      const sideQuestionPlannerDeps: SideQuestionPlannerDeps = {
        isRenderableSideQuestionAnswer: (answer) =>
          this.activeStreams.has(answer.id) || answer.parts.length > 0,
        buildDisplayedMessagesForMessage: (msg, snapshot, snapshots) =>
          this.buildDisplayedMessagesForMessage(msg, snapshot, snapshots),
      };
      const sideQuestionDisplayPlan = buildSideQuestionDisplayPlan(
        allMessages,
        shouldHideMessageFromTranscript,
        sideQuestionPlannerDeps
      );

      for (const message of allMessages) {
        maybeCollectAgentSkillSnapshot(message, latestAgentSkillSnapshotByKey);
        // Synthetic messages are typically for model context only.
        // Show them only in debug mode, or when explicitly marked as UI-visible.
        if (shouldHideMessageFromTranscript(message)) {
          continue;
        }

        const muxMeta = message.metadata?.muxMetadata;
        const agentSkillSnapshotKey =
          message.role === "user" && muxMeta?.type === "agent-skill"
            ? getAgentSkillSnapshotKey(muxMeta.scope, muxMeta.skillName)
            : undefined;

        const agentSkillSnapshot = agentSkillSnapshotKey
          ? latestAgentSkillSnapshotByKey.get(agentSkillSnapshotKey)
          : undefined;

        const agentSkillSnapshotForDisplay = agentSkillSnapshot
          ? { frontmatterYaml: agentSkillSnapshot.frontmatterYaml, body: agentSkillSnapshot.body }
          : undefined;

        const agentSkillSnapshotCacheKey = agentSkillSnapshot
          ? getAgentSkillSnapshotDisplayCacheKey(agentSkillSnapshot)
          : undefined;

        const inlineSkillSnapshotState =
          message.role === "user"
            ? deriveInlineSkillSnapshotDisplayState(
                muxMeta?.agentSkillRefs,
                latestAgentSkillSnapshotByKey
              )
            : undefined;
        const inlineSkillSnapshotsCacheKey = inlineSkillSnapshotState?.cacheKey;

        // Skip /btw rows that the split path is going to render INLINE
        // inside the interrupted message's display block. Without this
        // guard the side-question pair would render twice — once between
        // the split halves and once at its natural sequence position
        // (below the interrupted message).
        if (sideQuestionDisplayPlan.inlineSideQuestionMessageIds.has(message.id)) {
          continue;
        }

        const interrupts = sideQuestionDisplayPlan.interruptionsByInterruptedId.get(message.id);
        if (interrupts && message.role === "assistant") {
          // Interrupted main-agent message: build its display rows with
          // the /btw pair(s) interleaved in the middle. We bypass the
          // displayedMessageCache here because the split output is a
          // function of *multiple* messages' state — caching it under
          // one message id would miss invalidations on the children.
          const splitRows = buildInterruptedMessageDisplay(
            message,
            interrupts,
            sideQuestionPlannerDeps,
            agentSkillSnapshotForDisplay,
            inlineSkillSnapshotState?.snapshots
          );
          if (splitRows.length > 0) {
            displayedMessages.push(...splitRows);
          }
          continue;
        }

        const version = this.messageVersions.get(message.id) ?? 0;
        const cached = this.displayedMessageCache.get(message.id);
        const canReuse =
          cached?.version === version &&
          cached.agentSkillSnapshotCacheKey === agentSkillSnapshotCacheKey &&
          cached.inlineSkillSnapshotsCacheKey === inlineSkillSnapshotsCacheKey;

        const messageDisplay = canReuse
          ? cached.messages
          : this.buildDisplayedMessagesForMessage(
              message,
              agentSkillSnapshotForDisplay,
              inlineSkillSnapshotState?.snapshots
            );

        if (!canReuse) {
          this.displayedMessageCache.set(message.id, {
            version,
            agentSkillSnapshotCacheKey,
            inlineSkillSnapshotsCacheKey,
            messages: messageDisplay,
          });
        }

        if (messageDisplay.length > 0) {
          displayedMessages.push(...messageDisplay);
        }
      }

      let resultMessages = displayedMessages;

      // Limit messages for DOM performance (unless explicitly disabled).
      // Strategy: keep recent rows intact, preserve structural rows in older history,
      // and materialize omission runs as explicit history-hidden marker rows.
      // Full history is still maintained internally for token counting.
      if (!this.showAllMessages && displayedMessages.length > MAX_DISPLAYED_MESSAGES) {
        const truncationPlan = buildTranscriptTruncationPlan({
          displayedMessages,
          maxDisplayedMessages: MAX_DISPLAYED_MESSAGES,
          alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
        });

        resultMessages =
          truncationPlan.hiddenCount > 0
            ? this.normalizeLastPartFlags(truncationPlan.rows)
            : truncationPlan.rows;
      }

      resultMessages = markRowsBeforeLatestContextBoundary(resultMessages);

      // Add init state if present (ephemeral, appears at top)
      const initSnapshot = this.initStateHandler.getSnapshot();
      if (initSnapshot) {
        const durationMs =
          initSnapshot.endTime !== null
            ? initSnapshot.endTime - initSnapshot.startTime
            : null;
        const initMessage: DisplayedMessage = {
          type: "workspace-init",
          id: "workspace-init",
          historySequence: -1, // Appears before all history
          status: initSnapshot.status,
          hookPath: initSnapshot.hookPath,
          lines: [...initSnapshot.lines], // Shallow copy for React.memo change detection
          exitCode: initSnapshot.exitCode,
          timestamp: initSnapshot.startTime,
          durationMs,
          truncatedLines: initSnapshot.truncatedLines,
        };
        resultMessages = [initMessage, ...resultMessages];
      }

      // Return the full array
      this.cache.displayedMessages = resultMessages;
    }
    return this.cache.displayedMessages;
  }

  /**
   * Track a delta for token counting and TPS calculation
   */
  private trackDelta(
    messageId: string,
    tokens: number,
    timestamp: number,
    type: "text" | "reasoning" | "tool-args"
  ): void {
    this.tokenTracker.trackDelta(messageId, tokens, timestamp, type);
  }

  /**
   * Get streaming token count (sum of all deltas)
   */
  getStreamingTokenCount(messageId: string): number {
    return this.tokenTracker.getStreamingTokenCount(messageId);
  }

  /**
   * Get tokens-per-second rate (10-second trailing window)
   */
  getStreamingTPS(messageId: string): number {
    return this.tokenTracker.getStreamingTPS(messageId);
  }

  /**
   * Clear delta history for a message
   */
  clearTokenState(messageId: string): void {
    this.tokenTracker.clearTokenState(messageId);
  }

  /**
   * Handle usage-delta event: update usage tracking for active stream
   */
  handleUsageDelta(data: UsageDeltaEvent): void {
    this.tokenTracker.handleUsageDelta(data);
  }

  /**
   * Get active stream usage for context window display (last step's inputTokens = context size)
   */
  getActiveStreamUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.tokenTracker.getActiveStreamUsage(messageId);
  }

  /**
   * Get step provider metadata for context window cache display
   */
  getActiveStreamStepProviderMetadata(messageId: string): Record<string, unknown> | undefined {
    return this.tokenTracker.getActiveStreamStepProviderMetadata(messageId);
  }

  /**
   * Get active stream cumulative usage for cost display (sum of all steps)
   */
  getActiveStreamCumulativeUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.tokenTracker.getActiveStreamCumulativeUsage(messageId);
  }

  /**
   * Get cumulative provider metadata for cost display (with accumulated cache creation tokens)
   */
  getActiveStreamCumulativeProviderMetadata(
    messageId: string
  ): Record<string, unknown> | undefined {
    return this.tokenTracker.getActiveStreamCumulativeProviderMetadata(messageId);
  }
}
