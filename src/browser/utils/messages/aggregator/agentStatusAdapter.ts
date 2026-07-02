/**
 * AgentStatusAdapter — owns the agent-status lifecycle for a workspace.
 *
 * Agent status comes from two sources:
 *  1. `status_set` tool results (persisted to localStorage, survive reload)
 *  2. `displayStatus` in mux-metadata messages (transient, cleared on stream end)
 *
 * The adapter encapsulates the persistence + in-memory state so the aggregator
 * doesn't need to spread `agentStatus` / `lastStatusUrl` bookkeeping across
 * a dozen call sites.
 */
import { getStatusStateKey } from "@/common/constants/storage";
import { AgentStatusSchema, type AgentStatus } from "./schemas";

export class AgentStatusAdapter {
  private agentStatus: AgentStatus | undefined = undefined;
  private lastStatusUrl: string | undefined = undefined;
  private readonly workspaceId: string | undefined;

  constructor(workspaceId: string | undefined) {
    this.workspaceId = workspaceId;
    if (workspaceId) {
      const persisted = this.loadPersisted();
      if (persisted) {
        this.agentStatus = persisted;
        this.lastStatusUrl = persisted.url;
      }
    }
  }

  get(): AgentStatus | undefined {
    return this.agentStatus;
  }

  /**
   * Apply a `status_set` tool result.
   * Updates in-memory state and persists immediately.
   */
  setStatusFromResult(emoji: string, message: string, url: string | undefined): void {
    const effectiveUrl = url ?? this.lastStatusUrl;
    if (effectiveUrl) {
      this.lastStatusUrl = effectiveUrl;
    }
    this.agentStatus = { emoji, message, url: effectiveUrl };
    this.savePersisted(this.agentStatus);
  }

  /**
   * Set a transient status (from `displayStatus` in mux-metadata).
   * Does NOT persist — persisted value is only updated by `status_set`.
   */
  setTransient(status: AgentStatus | undefined): void {
    this.agentStatus = status;
  }

  /** Clear the in-memory status (preserves any persisted value). */
  clearTransient(): void {
    this.agentStatus = undefined;
  }

  /** Restore in-memory status from persisted storage. */
  restorePersisted(): void {
    this.agentStatus = this.loadPersisted();
    if (this.agentStatus) {
      this.lastStatusUrl = this.agentStatus.url;
    }
  }

  /** If no current status, try restoring from persisted. */
  restorePersistedIfEmpty(): void {
    if (!this.agentStatus) {
      this.restorePersisted();
    }
  }

  /** Clear both in-memory status and persisted value. */
  clearAll(): void {
    this.agentStatus = undefined;
    this.clearPersisted();
  }

  // ---- Persistence helpers (self-healing: never throw) ----

  private loadPersisted(): AgentStatus | undefined {
    if (!this.workspaceId) return undefined;
    try {
      const stored = localStorage.getItem(getStatusStateKey(this.workspaceId));
      if (!stored) return undefined;
      const parsed = AgentStatusSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Ignore localStorage errors or JSON parse failures
    }
    return undefined;
  }

  private savePersisted(status: AgentStatus): void {
    if (!this.workspaceId) return;
    const parsed = AgentStatusSchema.safeParse(status);
    if (!parsed.success) return;
    try {
      localStorage.setItem(getStatusStateKey(this.workspaceId), JSON.stringify(parsed.data));
    } catch {
      // Ignore localStorage errors
    }
  }

  private clearPersisted(): void {
    if (!this.workspaceId) return;
    try {
      localStorage.removeItem(getStatusStateKey(this.workspaceId));
    } catch {
      // Ignore localStorage errors
    }
  }
}
