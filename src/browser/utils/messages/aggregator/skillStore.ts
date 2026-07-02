import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import {
  AgentSkillSnapshotMetadataSchema,
  AgentSkillReadInputSchema,
  parseAgentSkillReadToolResult,
} from "./schemas";

export type LoadedSkill = AgentSkillDescriptor;

/** A runtime skill load failure (agent_skill_read returned { success: false }) */
export interface SkillLoadError {
  /** Skill name that was requested */
  name: string;
  /** Error message from the backend */
  error: string;
}

/**
 * Tracks loaded skills and skill-load errors during a streaming session.
 *
 * Keeps stable array references for memoized consumers — the cache arrays
 * only change when the underlying Map actually changes, so `getLoadedSkills()`
 * returns the same `LoadedSkill[]` reference across renders until a skill is
 * added/removed.
 */
export class SkillStore {
  private loadedSkills = new Map<string, LoadedSkill>();
  private loadedSkillsCache: LoadedSkill[] = [];

  private skillLoadErrors = new Map<string, SkillLoadError>();
  private skillLoadErrorsCache: SkillLoadError[] = [];

  getLoadedSkills(): LoadedSkill[] {
    return this.loadedSkillsCache;
  }

  getSkillLoadErrors(): SkillLoadError[] {
    return this.skillLoadErrorsCache;
  }

  /** Register a successfully loaded skill, superseding any previous error. */
  trackLoadedSkill(skill: LoadedSkill): void {
    const existing = this.loadedSkills.get(skill.name);
    if (
      existing?.name === skill.name &&
      existing.description === skill.description &&
      existing.scope === skill.scope
    ) {
      return;
    }

    this.loadedSkills.set(skill.name, skill);
    this.loadedSkillsCache = Array.from(this.loadedSkills.values());

    if (this.skillLoadErrors.delete(skill.name)) {
      this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());
    }
  }

  /** Record a skill-load failure, superseding any previous success. */
  trackSkillLoadError(name: string, error: string): void {
    const existing = this.skillLoadErrors.get(name);
    if (existing?.error === error) return;

    this.skillLoadErrors.set(name, { name, error });
    this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());

    if (this.loadedSkills.delete(name)) {
      this.loadedSkillsCache = Array.from(this.loadedSkills.values());
    }
  }

  /**
   * Track a loaded skill from an `agentSkillSnapshot` metadata field on a
   * message. Uses a placeholder description so the skill shows up in the UI
   * even before `agent_skill_read` resolves with full frontmatter.
   */
  maybeTrackLoadedSkillFromAgentSkillSnapshot(snapshot: unknown): void {
    const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshot);
    if (!parsed.success) {
      return;
    }

    const { skillName, scope } = parsed.data;

    // Don't override an existing entry (e.g. from agent_skill_read) with a
    // placeholder description.
    if (this.loadedSkills.has(skillName)) {
      return;
    }

    this.trackLoadedSkill({
      name: skillName,
      description: `(loaded via /${skillName})`,
      scope,
    });
  }

  /** Process an `agent_skill_read` tool result, updating skills or errors. */
  handleAgentSkillReadResult(input: unknown, output: unknown): void {
    const result = parseAgentSkillReadToolResult(output);
    if (!result) {
      return;
    }

    if (result.success) {
      const skill = result.skill;
      this.trackLoadedSkill({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        scope: skill.scope,
      });
      return;
    }

    const parsedInput = AgentSkillReadInputSchema.safeParse(input);
    const skillName = parsedInput.success ? parsedInput.data.name : undefined;
    if (skillName) {
      this.trackSkillLoadError(skillName, result.error);
    }
  }

  /** Reset all tracked skills and errors (used during history replay). */
  clear(): void {
    this.loadedSkills.clear();
    this.loadedSkillsCache = [];
    this.skillLoadErrors.clear();
    this.skillLoadErrorsCache = [];
  }
}
