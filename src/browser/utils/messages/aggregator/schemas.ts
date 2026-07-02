/**
 * Zod schemas and parse helpers extracted from StreamingMessageAggregator.
 *
 * These are pure, stateless validators used to safely coerce tool-result
 * payloads from the wire into typed objects.  Keeping them in a dedicated
 * module makes the aggregator easier to audit and lets tests import the
 * parsers without pulling in the full class.
 */
import { z } from "zod";
import type {
  TodoItem,
  StatusSetToolResult,
  NotifyToolResult,
  AgentSkillReadToolResult,
} from "@/common/types/tools";
import { AgentSkillReadToolResultSchema } from "@/common/utils/tools/toolDefinitions";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

// Synthetic agent-skill snapshot messages include metadata.agentSkillSnapshot.
// We use this to keep the SkillIndicator in sync for /{skillName} invocations.
export const AgentSkillSnapshotMetadataSchema = z.object({
  skillName: z.string().min(1),
  scope: z.enum(["project", "global", "built-in"]),
  sha256: z.string().optional(),
  frontmatterYaml: z.string().optional(),
});

export const TodoWriteInputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    })
  ),
});

export const StatusSetSuccessResultSchema = z.object({
  success: z.literal(true),
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
}) satisfies z.ZodType<Extract<StatusSetToolResult, { success: true }>>;

export const ReviewPaneUpdateSuccessResultSchema = z.object({
  success: z.literal(true),
  operation: z.enum(["add", "replace"]),
  hunks: z.array(
    z.object({
      path: z.string(),
      comment: z.string().nullable().optional(),
    })
  ),
});

export const NotifySuccessResultSchema = z.object({
  success: z.literal(true),
  title: z.string(),
  message: z.string().optional(),
}) satisfies z.ZodType<Extract<NotifyToolResult, { success: true }>>;

export const AgentSkillReadInputSchema = z.object({
  name: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseLegacyNotifyRouting(
  output: unknown
): { notifiedVia?: string; workspaceId?: string } | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const record = output as Record<string, unknown>;
  return {
    notifiedVia: typeof record.notifiedVia === "string" ? record.notifiedVia : undefined,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
  };
}

export function parseAgentSkillReadToolResult(output: unknown): AgentSkillReadToolResult | null {
  const parsed = AgentSkillReadToolResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export function parseTodoWriteInput(input: unknown): { todos: TodoItem[] } | null {
  const parsed = TodoWriteInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseStatusSetSuccessResult(
  output: unknown
): Extract<StatusSetToolResult, { success: true }> | null {
  const parsed = StatusSetSuccessResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export function parseNotifySuccessResult(
  output: unknown
): Extract<NotifyToolResult, { success: true }> | null {
  const parsed = NotifySuccessResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
