import type { MuxMessage, DisplayedMessage, SideQuestionDisplayBranch, InlineSkillSnapshotMap } from "@/common/types/message";
import {
  isSideQuestionAnswerMessage,
  isSideQuestionUserMessage,
} from "@/common/utils/messages/sideQuestion";

// ----- Types (moved from StreamingMessageAggregator) -----

/**
 * Narrowed metadata shapes. The type guards from sideQuestion.ts narrow the
 * full MuxMetadata union, but tsgo's intersection resolution differs from
 * the standard compiler when the narrowed type is used in a different module.
 * These local shapes let us cast without relying on non-exported aliases.
 */
interface SideQuestionUserMeta {
  type: "side-question";
  interruptedMessageId?: string;
  interruptedTextLength?: number;
  interruptedHistorySequence?: number;
  interruptedPartIndex?: number;
}

interface SideQuestionAnswerMeta {
  type: "side-question-answer";
  questionMessageId?: string;
}

export interface MessagePartSplitCut {
  textLength: number;
  partIndex?: number;
}

export interface SideQuestionDisplayPlan {
  interruptionsByInterruptedId: Map<string, SideQuestionInterrupt[]>;
  inlineSideQuestionMessageIds: Set<string>;
}

export interface SideQuestionInterrupt {
  atTextLength: number;
  atPartIndex?: number;
  sideQuestionUserMsg: MuxMessage;
  sideQuestionAnswerMsg?: MuxMessage;
}

// ----- Dependencies the planner needs from the host -----

export interface SideQuestionPlannerDeps {
  /** Check whether a side-answer message is actively streaming or has content. */
  isRenderableSideQuestionAnswer: (answer: MuxMessage) => boolean;
  /** Build displayed rows for a single message (delegates to displayedMessageBuilder). */
  buildDisplayedMessagesForMessage: (
    message: MuxMessage,
    agentSkillSnapshot?: { frontmatterYaml?: string; body?: string },
    inlineSkillSnapshots?: InlineSkillSnapshotMap
  ) => DisplayedMessage[];
}

// ----- Pure functions -----

export function compareSideQuestionInterrupts(
  left: SideQuestionInterrupt,
  right: SideQuestionInterrupt
): number {
  const leftHistorySequence = left.sideQuestionUserMsg.metadata?.historySequence ?? Infinity;
  const rightHistorySequence = right.sideQuestionUserMsg.metadata?.historySequence ?? Infinity;
  return (
    left.atTextLength - right.atTextLength ||
    (left.atPartIndex ?? Infinity) - (right.atPartIndex ?? Infinity) ||
    leftHistorySequence - rightHistorySequence ||
    left.sideQuestionUserMsg.id.localeCompare(right.sideQuestionUserMsg.id)
  );
}

export function buildSideQuestionDisplayPlan(
  allMessages: readonly MuxMessage[],
  shouldHideMessageFromTranscript: (message: MuxMessage) => boolean,
  deps: SideQuestionPlannerDeps
): SideQuestionDisplayPlan {
  const messagesById = new Map<string, MuxMessage>();
  const linkedSideAnswerByQuestionId = new Map<string, MuxMessage>();
  for (const message of allMessages) {
    messagesById.set(message.id, message);
    if (!isSideQuestionAnswerMessage(message)) {
      continue;
    }

    const questionMessageId = (message.metadata?.muxMetadata as SideQuestionAnswerMeta)
      ?.questionMessageId;
    if (typeof questionMessageId === "string") {
      linkedSideAnswerByQuestionId.set(questionMessageId, message);
    }
  }

  const interruptionsByInterruptedId = new Map<string, SideQuestionInterrupt[]>();
  const inlineSideQuestionMessageIds = new Set<string>();

  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (!isSideQuestionUserMessage(msg)) {
      continue;
    }

    // Type narrowed by isSideQuestionUserMessage; cast avoids intersection resolution issue in tsgo.
    const muxMeta = (msg.metadata?.muxMetadata ?? {}) as SideQuestionUserMeta;
    if (
      typeof muxMeta.interruptedMessageId !== "string" ||
      typeof muxMeta.interruptedTextLength !== "number" ||
      !Number.isFinite(muxMeta.interruptedTextLength)
    ) {
      continue;
    }

    const interruptedMessage = messagesById.get(muxMeta.interruptedMessageId);
    if (
      interruptedMessage?.role !== "assistant" ||
      isSideQuestionAnswerMessage(interruptedMessage) ||
      shouldHideMessageFromTranscript(interruptedMessage)
    ) {
      continue;
    }

    // Use the persisted sequence as part of the anchor identity so a stale
    // /btw snapshot cannot split an unrelated assistant message that happens
    // to reuse the same id after history repair or compaction-edge replay.
    if (
      typeof muxMeta.interruptedHistorySequence === "number" &&
      interruptedMessage.metadata?.historySequence !== muxMeta.interruptedHistorySequence
    ) {
      continue;
    }

    const linkedAnswer = linkedSideAnswerByQuestionId.get(msg.id);
    const next = allMessages[i + 1];
    const adjacentAnswer =
      next !== undefined && isSideQuestionAnswerMessage(next) ? next : undefined;
    const adjacentAnswerQuestionId = (
      adjacentAnswer?.metadata?.muxMetadata as SideQuestionAnswerMeta | undefined
    )?.questionMessageId;
    const legacyAdjacentAnswer =
      adjacentAnswer !== undefined && adjacentAnswerQuestionId === undefined
        ? adjacentAnswer
        : undefined;
    const answer = linkedAnswer ?? legacyAdjacentAnswer;
    const answerIsRenderable =
      answer !== undefined && deps.isRenderableSideQuestionAnswer(answer);
    const entry: SideQuestionInterrupt = {
      atTextLength: Math.max(0, muxMeta.interruptedTextLength),
      atPartIndex:
        typeof muxMeta.interruptedPartIndex === "number"
          ? muxMeta.interruptedPartIndex
          : undefined,
      sideQuestionUserMsg: msg,
      sideQuestionAnswerMsg: answerIsRenderable ? answer : undefined,
    };
    const existing = interruptionsByInterruptedId.get(muxMeta.interruptedMessageId);
    if (existing) {
      existing.push(entry);
    } else {
      interruptionsByInterruptedId.set(muxMeta.interruptedMessageId, [entry]);
    }

    // Decide split ownership before the display walk starts. This keeps
    // anchored /btw rows from ever rendering once at their chronological tail
    // and again inside the interrupted assistant split.
    inlineSideQuestionMessageIds.add(msg.id);
    if (answerIsRenderable && answer) {
      inlineSideQuestionMessageIds.add(answer.id);
    }
  }

  for (const interruptions of interruptionsByInterruptedId.values()) {
    interruptions.sort((left, right) => compareSideQuestionInterrupts(left, right));
  }

  return { interruptionsByInterruptedId, inlineSideQuestionMessageIds };
}

function getInterruptedSideQuestionBranch(
  interruptedMessage: MuxMessage,
  interrupt: SideQuestionInterrupt
): SideQuestionDisplayBranch {
  return {
    branchId: interrupt.sideQuestionUserMsg.id,
    placement: "interrupted",
    interruptedMessageId: interruptedMessage.id,
    interruptedHistorySequence: interruptedMessage.metadata?.historySequence,
  };
}

function applySideQuestionBranch(
  rows: DisplayedMessage[],
  branch: SideQuestionDisplayBranch
): DisplayedMessage[] {
  let didChange = false;
  const markedRows = rows.map((row) => {
    if (row.type === "user" && row.isSideQuestion === true) {
      didChange = true;
      return { ...row, sideQuestionBranch: branch };
    }
    if (row.type === "assistant" && row.isSideAnswer === true) {
      didChange = true;
      return { ...row, sideQuestionBranch: branch };
    }
    return row;
  });
  return didChange ? markedRows : rows;
}

/**
 * Split a list of message parts at one or more cumulative-text-length
 * boundaries.
 *
 * Only `text` parts contribute to the cumulative length — reasoning and
 * tool parts pass through to whichever segment is currently being filled.
 * Non-text parts always land in the segment that owns the cumulative
 * text position immediately before they appear in `parts`, which keeps
 * "the reasoning that happened before the user fired /btw" anchored on
 * the pre-aside side of the split.
 *
 * Returns `cutPoints.length + 1` segments. Each segment may be empty
 * (no parts) if the boundaries coincide or the message has no content
 * before/after a boundary.
 */
export function splitMessagePartsAtTextLengths(
  parts: MuxMessage["parts"],
  cutPoints: readonly MessagePartSplitCut[]
): Array<MuxMessage["parts"]> {
  const sortedCuts = [...cutPoints].sort(
    (a, b) => a.textLength - b.textLength || (a.partIndex ?? Infinity) - (b.partIndex ?? Infinity)
  );
  const segments: Array<MuxMessage["parts"]> = sortedCuts.map(() => []);
  segments.push([]);

  let cumulativeText = 0;
  let currentSegment = 0;

  const advanceThroughCuts = (newCumulative: number, nextPartIndex: number): void => {
    while (currentSegment < sortedCuts.length) {
      const cut = sortedCuts[currentSegment];
      if (newCumulative < cut.textLength) {
        return;
      }
      if (cut.partIndex !== undefined && nextPartIndex < cut.partIndex) {
        return;
      }
      currentSegment++;
    }
  };

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    advanceThroughCuts(cumulativeText, partIndex);
    if (part.type !== "text") {
      // Reasoning / tool / file parts ride with the current segment.
      // interruptedPartIndex keeps non-text parts already visible at the
      // same cumulative text offset on the pre-aside side after reload.
      segments[currentSegment].push(part);
      advanceThroughCuts(cumulativeText, partIndex + 1);
      continue;
    }

    // Walk this text part across as many boundaries as it crosses. Each
    // boundary peels off a prefix into the current segment, advances
    // currentSegment, and leaves the remainder to be considered against
    // the next boundary.
    let remaining = part.text;
    while (currentSegment < sortedCuts.length) {
      const cut = sortedCuts[currentSegment];
      if (cut.partIndex !== undefined && partIndex + 1 < cut.partIndex) {
        // This split point is after a later non-text part at the same text
        // offset; keep this whole text part in the current segment for now.
        break;
      }
      const charsLeftInCurrentSegment = cut.textLength - cumulativeText;
      if (charsLeftInCurrentSegment >= remaining.length) {
        // This part fits entirely inside the current segment.
        break;
      }
      if (charsLeftInCurrentSegment <= 0) {
        advanceThroughCuts(cumulativeText, partIndex + 1);
        continue;
      }
      const prefix = remaining.slice(0, charsLeftInCurrentSegment);
      if (prefix.length > 0) {
        // Preserve part metadata (e.g. timestamp) on each half.
        segments[currentSegment].push({ ...part, text: prefix });
      }
      cumulativeText = cut.textLength;
      remaining = remaining.slice(charsLeftInCurrentSegment);
      advanceThroughCuts(cumulativeText, partIndex + 1);
    }

    if (remaining.length > 0) {
      segments[currentSegment].push({ ...part, text: remaining });
      cumulativeText += remaining.length;
      advanceThroughCuts(cumulativeText, partIndex + 1);
    }
  }

  return segments;
}

/**
 * Build displayed rows for a main-agent assistant message that was
 * interrupted by one or more /btw side questions.
 *
 * The interrupted message is split at each captured text-length
 * boundary; the side-question Q+A pair for each interrupt is inserted
 * between the surrounding segments. The result is a continuous run of
 * displayed rows that reads:
 *
 *   [M1 pre-aside]
 *   [Q1]
 *   [A1]
 *   [M1 middle (if multiple /btw interrupted the same turn)]
 *   ...
 *   [M1 post-aside]
 *
 * The LAST segment keeps M1's original message id so an active stream
 * lookup still surfaces the streaming indicator on the right row.
 * Earlier segments use `${M1.id}#seg<i>` suffixes for React key
 * stability; their `historyId` is rewritten back to `M1.id` so action
 * handlers (Copy / Start Here / etc.) still target the persisted message.
 */
export function buildInterruptedMessageDisplay(
  message: MuxMessage,
  interrupts: readonly SideQuestionInterrupt[],
  deps: SideQuestionPlannerDeps,
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string },
  inlineSkillSnapshots?: InlineSkillSnapshotMap
): DisplayedMessage[] {
  const sorted = [...interrupts].sort((left, right) =>
    compareSideQuestionInterrupts(left, right)
  );
  const segments = splitMessagePartsAtTextLengths(
    message.parts,
    sorted.map((interrupt) => ({
      textLength: interrupt.atTextLength,
      partIndex: interrupt.atPartIndex,
    }))
  );

  const result: DisplayedMessage[] = [];

  for (let i = 0; i < segments.length; i++) {
    const isLastSegment = i === segments.length - 1;
    const segParts = segments[i];

    // Always render the last segment even if empty — it owns the
    // streaming-indicator anchor and the meta row. Earlier segments
    // skip when empty to avoid emitting hollow blocks.
    if (segParts.length > 0 || isLastSegment) {
      // Last segment keeps the original id so activeStreams lookup hits;
      // earlier segments get a suffixed id for React key uniqueness.
      const segMessageId = isLastSegment ? message.id : `${message.id}#seg${i}`;
      const segMessage: MuxMessage = {
        ...message,
        id: segMessageId,
        parts: segParts,
      };

      const segRows = deps.buildDisplayedMessagesForMessage(
        segMessage,
        agentSkillSnapshot,
        inlineSkillSnapshots
      );

      // Rewrite `historyId` on each emitted row back to the original
      // message id. Without this rewrite, action handlers that resolve
      // a row to its backend message (Start Here, Fork, etc.) would
      // hit "message not found" because no real history row exists
      // under the suffixed segment id.
      if (!isLastSegment) {
        for (const row of segRows) {
          if ("historyId" in row && row.historyId === segMessageId) {
            (row as { historyId: string }).historyId = message.id;
          }
        }
      }

      result.push(...segRows);
    }

    if (i < sorted.length) {
      const interrupt = sorted[i];
      const branch = getInterruptedSideQuestionBranch(message, interrupt);
      result.push(
        ...applySideQuestionBranch(
          deps.buildDisplayedMessagesForMessage(interrupt.sideQuestionUserMsg),
          branch
        )
      );
      if (interrupt.sideQuestionAnswerMsg) {
        result.push(
          ...applySideQuestionBranch(
            deps.buildDisplayedMessagesForMessage(interrupt.sideQuestionAnswerMsg),
            branch
          )
        );
      }
    }
  }

  return result;
}
