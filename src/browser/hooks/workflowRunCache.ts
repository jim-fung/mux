import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import {
  getNewestWorkflowRunSnapshot,
  shouldContinueWorkflowRunPolling,
} from "./workflowRunHelpers";

const WORKFLOW_RUN_REFRESH_INTERVAL_MS = 2_000;

export interface WorkflowRunSnapshot {
  run: WorkflowRunRecord | null;
  loading: boolean;
  error: string | null;
}

interface CacheEntry {
  workspaceId: string;
  runId: string;
  run: WorkflowRunRecord | null;
  loading: boolean;
  error: string | null;
  snapshot: WorkflowRunSnapshot;
  listeners: Set<() => void>;
  refCount: number;
  api: RouterClient<AppRouter> | null;
  pollTimeout: ReturnType<typeof setTimeout> | null;
  refreshPromise: Promise<void> | null;
  // Track the most permissive polling config across all current subscribers.
  anyPollWhileActive: boolean;
  anyPollAfterTerminal: boolean;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, runId: string): string {
  return `${workspaceId}::${runId}`;
}

function createSnapshot(entry: CacheEntry): WorkflowRunSnapshot {
  return { run: entry.run, loading: entry.loading, error: entry.error };
}

function getOrCreateEntry(workspaceId: string, runId: string): CacheEntry {
  const key = cacheKey(workspaceId, runId);
  let entry = cache.get(key);
  if (entry == null) {
    entry = {
      workspaceId,
      runId,
      run: null,
      loading: false,
      error: null,
      snapshot: { run: null, loading: false, error: null },
      listeners: new Set(),
      refCount: 0,
      api: null,
      pollTimeout: null,
      refreshPromise: null,
      anyPollWhileActive: false,
      anyPollAfterTerminal: false,
    };
    cache.set(key, entry);
  }
  return entry;
}

function updateSnapshot(entry: CacheEntry): void {
  entry.snapshot = createSnapshot(entry);
  for (const listener of entry.listeners) {
    listener();
  }
}

function shouldPoll(entry: CacheEntry): boolean {
  return shouldContinueWorkflowRunPolling({
    pollWhileActive: entry.anyPollWhileActive,
    pollAfterTerminal: entry.anyPollAfterTerminal,
    run: entry.run,
  });
}

function scheduleNextRefresh(entry: CacheEntry): void {
  if (entry.pollTimeout != null || !shouldPoll(entry)) {
    return;
  }

  entry.pollTimeout = globalThis.setTimeout(() => {
    entry.pollTimeout = null;
    void refresh(entry);
  }, WORKFLOW_RUN_REFRESH_INTERVAL_MS);
}

async function refresh(entry: CacheEntry): Promise<void> {
  if (entry.refreshPromise != null || entry.api == null) {
    return;
  }

  const api = entry.api;

  entry.refreshPromise = (async () => {
    let nextRun: WorkflowRunRecord | null = null;

    try {
      nextRun = await api.workflows.getRun({
        workspaceId: entry.workspaceId,
        runId: entry.runId,
      });
      entry.run = getNewestWorkflowRunSnapshot(entry.run, nextRun);
      entry.error = null;
      entry.loading = false;
      updateSnapshot(entry);
    } catch (fetchError) {
      entry.error =
        fetchError instanceof Error ? fetchError.message : "Failed to load workflow run";
      entry.loading = false;
      updateSnapshot(entry);
    } finally {
      entry.refreshPromise = null;
      scheduleNextRefresh(entry);
    }
  })();

  await entry.refreshPromise;
}

export interface SubscribeOptions {
  api: RouterClient<AppRouter> | null;
  pollWhileActive?: boolean;
  pollAfterTerminal?: boolean;
}

export function subscribeWorkflowRun(
  workspaceId: string,
  runId: string,
  options: SubscribeOptions,
  listener: () => void
): () => void {
  const entry = getOrCreateEntry(workspaceId, runId);

  entry.listeners.add(listener);
  entry.refCount += 1;

  // Update API reference (all callers share the same singleton client).
  if (options.api != null) {
    entry.api = options.api;
  }

  // Expand polling config to the union of all subscribers.
  const configChanged =
    (options.pollWhileActive === true && !entry.anyPollWhileActive) ||
    (options.pollAfterTerminal === true && !entry.anyPollAfterTerminal);

  if (options.pollWhileActive === true) {
    entry.anyPollWhileActive = true;
  }
  if (options.pollAfterTerminal === true) {
    entry.anyPollAfterTerminal = true;
  }

  // Start initial fetch + polling if this is the first subscriber (or config expanded).
  if (entry.refCount === 1) {
    entry.loading = true;
    updateSnapshot(entry);
    void refresh(entry);
  } else if (configChanged) {
    scheduleNextRefresh(entry);
  }

  return () => {
    entry.listeners.delete(listener);
    entry.refCount -= 1;

    if (entry.refCount <= 0) {
      // Last subscriber gone — stop polling and clean up.
      if (entry.pollTimeout != null) {
        globalThis.clearTimeout(entry.pollTimeout);
        entry.pollTimeout = null;
      }
      cache.delete(cacheKey(workspaceId, runId));
    }
  };
}

export function getWorkflowRunSnapshot(workspaceId: string, runId: string): WorkflowRunSnapshot {
  const key = cacheKey(workspaceId, runId);
  return cache.get(key)?.snapshot ?? { run: null, loading: false, error: null };
}

// Test helper: clear the entire cache between tests.
export function _clearWorkflowRunCacheForTests(): void {
  for (const entry of cache.values()) {
    if (entry.pollTimeout != null) {
      window.clearTimeout(entry.pollTimeout);
    }
  }
  cache.clear();
}
