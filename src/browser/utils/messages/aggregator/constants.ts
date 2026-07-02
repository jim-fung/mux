import type { DisplayedMessage } from "@/common/types/message";

/**
 * Maximum number of DisplayedMessages to render before truncation kicks in.
 * We keep all user prompts and structural markers, while allowing older assistant
 * content to collapse behind history-hidden markers for faster initial paint.
 */
export const MAX_DISPLAYED_MESSAGES = 64;

/**
 * Message types that are always preserved even in truncated history.
 * Older assistant/tool/reasoning rows may be omitted until the user clicks "Load all".
 */
export const ALWAYS_KEEP_MESSAGE_TYPES = new Set<DisplayedMessage["type"]>([
  "user",
  "stream-error",
  "compaction-boundary",
  "plan-display",
  "workspace-init",
]);
