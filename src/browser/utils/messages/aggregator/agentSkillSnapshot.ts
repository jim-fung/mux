/**
 * Agent-skill snapshot helpers extracted from StreamingMessageAggregator.
 *
 * These functions parse synthetic snapshot messages injected by the backend
 * and project them into an inline-skill display map used by message rows.
 */
import type {
  MuxMessage,
  InlineSkillSnapshotMap,
  AgentSkillReference,
} from "@/common/types/message";
import type { AgentSkillScope } from "@/common/types/agentSkill";
import { assert } from "@/common/utils/assert";
import { getTextPartContent } from "../displayedMessageBuilder";
import { AgentSkillSnapshotMetadataSchema } from "./schemas";

export interface AgentSkillSnapshotContent {
  sha256?: string;
  frontmatterYaml?: string;
  body?: string;
}

export interface InlineSkillSnapshotDisplayState {
  snapshots?: InlineSkillSnapshotMap;
  cacheKey?: string;
}

export function getAgentSkillSnapshotDisplayCacheKey(snapshot: AgentSkillSnapshotContent): string {
  // Displayed skill rows render both frontmatter and body. Include all rendered
  // fields rather than trusting optional legacy sha256, so cache reuse is safe
  // for old histories and synthetic snapshot edits.
  return JSON.stringify({
    sha256: snapshot.sha256 ?? "",
    frontmatterYaml: snapshot.frontmatterYaml ?? "",
    body: snapshot.body ?? "",
  });
}

export function getAgentSkillSnapshotKey(scope: AgentSkillScope, skillName: string): string {
  return `${scope}:${skillName}`;
}

export function extractAgentSkillSnapshotBody(snapshotText: string): string | null {
  assert(typeof snapshotText === "string", "extractAgentSkillSnapshotBody requires snapshotText");

  // Expected format (backend):
  // <agent-skill ...>\n{body}\n</agent-skill>
  if (!snapshotText.startsWith("<agent-skill")) {
    return null;
  }

  const openTagEnd = snapshotText.indexOf(">\n");
  if (openTagEnd === -1) {
    return null;
  }

  const closeTag = "\n</agent-skill>";
  const closeTagStart = snapshotText.lastIndexOf(closeTag);
  if (closeTagStart === -1) {
    return null;
  }

  const bodyStart = openTagEnd + ">\n".length;
  if (closeTagStart < bodyStart) {
    return null;
  }

  // Be strict about trailing content: if we can't confidently extract the body,
  // avoid showing a misleading preview.
  const trailing = snapshotText.slice(closeTagStart + closeTag.length);
  if (trailing.trim().length > 0) {
    return null;
  }

  return snapshotText.slice(bodyStart, closeTagStart);
}

export function maybeCollectAgentSkillSnapshot(
  message: MuxMessage,
  snapshots: Map<string, AgentSkillSnapshotContent>
): void {
  const snapshotMeta = message.metadata?.agentSkillSnapshot;
  if (!snapshotMeta) {
    return;
  }

  const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshotMeta);
  if (!parsed.success) {
    return;
  }

  const body = extractAgentSkillSnapshotBody(getTextPartContent(message.parts));
  if (body === null) {
    return;
  }

  snapshots.set(getAgentSkillSnapshotKey(parsed.data.scope, parsed.data.skillName), {
    sha256: parsed.data.sha256,
    frontmatterYaml: parsed.data.frontmatterYaml,
    body,
  });
}

function isAgentSkillReferenceArray(
  refs: readonly AgentSkillReference[] | undefined
): refs is readonly AgentSkillReference[] {
  return Array.isArray(refs);
}

export function deriveInlineSkillSnapshotDisplayState(
  refs: readonly AgentSkillReference[] | undefined,
  latestAgentSkillSnapshotByKey: ReadonlyMap<string, AgentSkillSnapshotContent>
): InlineSkillSnapshotDisplayState {
  if (!isAgentSkillReferenceArray(refs) || refs.length === 0) {
    return {};
  }

  const snapshotsBySkillName: InlineSkillSnapshotMap = {};
  const cacheEntryBySkillName = new Map<string, string>();

  for (const ref of refs) {
    if (ref.source !== "inline") {
      continue;
    }

    const snapshot = latestAgentSkillSnapshotByKey.get(
      getAgentSkillSnapshotKey(ref.scope, ref.skillName)
    );
    if (!snapshot || (snapshot.frontmatterYaml === undefined && snapshot.body === undefined)) {
      continue;
    }

    snapshotsBySkillName[ref.skillName] = {
      skillName: ref.skillName,
      scope: ref.scope,
      snapshot: {
        frontmatterYaml: snapshot.frontmatterYaml,
        body: snapshot.body,
      },
    };
    cacheEntryBySkillName.set(
      ref.skillName,
      JSON.stringify({
        scope: ref.scope,
        skillName: ref.skillName,
        snapshot: getAgentSkillSnapshotDisplayCacheKey(snapshot),
      })
    );
  }

  if (cacheEntryBySkillName.size === 0) {
    return {};
  }

  return {
    snapshots: snapshotsBySkillName,
    cacheKey: Array.from(cacheEntryBySkillName.entries())
      .sort(([leftSkillName], [rightSkillName]) => leftSkillName.localeCompare(rightSkillName))
      .map(([, cacheEntry]) => cacheEntry)
      .join("\n"),
  };
}
