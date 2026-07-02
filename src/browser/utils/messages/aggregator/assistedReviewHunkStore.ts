import type { AssistedReviewHunk } from "@/common/types/review";
import {
  formatAssistedFilter,
  parseAssistedFilter,
} from "@/common/utils/review/assistedReview";
import { ReviewPaneUpdateSuccessResultSchema } from "./schemas";

/** Optional context passed through from `processToolResult`. */
export interface ReviewHunkMessageContext {
  /** Timestamp of the assistant message that owns this tool call. */
  timestamp?: number;
}

/**
 * Tracks the set of agent-flagged assisted-review hunks (updated from
 * `review_pane_update` tool results).
 *
 * Carries `addedAt` per pin so the UI can render a transient "new" badge.
 * Carryover semantics:
 *   - `operation: "add"` — a previously-seen key keeps its original `addedAt`.
 *   - `operation: "replace"` — every entry is treated as new for metadata.
 */
export class AssistedReviewHunkStore {
  private hunks: AssistedReviewHunk[] = [];

  get(): AssistedReviewHunk[] {
    return this.hunks;
  }

  /**
   * Merge parsed `review_pane_update` result into the store.
   *
   * @param output - raw tool output
   * @param messageContext - optional timestamp for "new" badge stamping
   * @returns `true` if the store changed
   */
  updateFromToolResult(output: unknown, messageContext?: ReviewHunkMessageContext): boolean {
    const parsed = ReviewPaneUpdateSuccessResultSchema.safeParse(output);
    if (!parsed.success) return false;

    const previousByKey = new Map<string, AssistedReviewHunk>();
    for (const prev of this.hunks) {
      previousByKey.set(formatAssistedFilter(prev), prev);
    }

    const isAdd = parsed.data.operation === "add";

    const next: AssistedReviewHunk[] = [];
    for (const entry of parsed.data.hunks) {
      const filter = parseAssistedFilter(entry.path);
      if (!filter) continue;
      const candidate: AssistedReviewHunk = {
        path: filter.path,
        range: filter.range,
        comment: entry.comment ?? undefined,
      };
      const key = formatAssistedFilter(candidate);
      const previous = previousByKey.get(key);
      if (isAdd && previous) {
        // Carry forward addedAt for `add` ops only so a refined comment
        // doesn't reset the "new" badge.
        candidate.addedAt = previous.addedAt;
      } else if (messageContext?.timestamp !== undefined) {
        // `replace` op (or first time we've seen this key under any op):
        // stamp with the current message's timestamp. `replace` is an
        // explicit republish, so reuse of an old key should still re-arm
        // the "new" badge. Replay deliberately omits the timestamp so
        // historical pins don't all light up as "new" on initial load.
        candidate.addedAt = messageContext.timestamp;
      }
      next.push(candidate);
    }
    this.hunks = next;
    return true;
  }
}
