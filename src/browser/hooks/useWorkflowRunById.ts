import { useContext, useSyncExternalStore } from "react";

import { APIContext } from "@/browser/contexts/API";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import {
  subscribeWorkflowRun,
  getWorkflowRunSnapshot,
} from "./workflowRunCache";

// Re-export helpers from the dedicated helpers module for backwards compatibility
// with existing consumers that imported them from this module.
export {
  getNewestWorkflowRunSnapshot,
  shouldContinueWorkflowRunPolling,
} from "./workflowRunHelpers";

// Re-export the cache types and helpers for consumers that imported them from here.
export type { WorkflowRunSnapshot } from "./workflowRunCache";

export interface UseWorkflowRunByIdResult {
  run: WorkflowRunRecord | null;
  loading: boolean;
  error: string | null;
}

const IDLE_SNAPSHOT: UseWorkflowRunByIdResult = { run: null, loading: false, error: null };

export function useWorkflowRunById(input: {
  workspaceId?: string;
  runId?: string;
  enabled?: boolean;
  pollWhileActive?: boolean;
  pollAfterTerminal?: boolean;
}): UseWorkflowRunByIdResult {
  const apiState = useContext(APIContext);
  const enabled = input.enabled !== false;
  const api = apiState?.api;
  const workspaceId = input.workspaceId;
  const runId = input.runId;

  const isReady = enabled && workspaceId != null && runId != null;

  const snapshot = useSyncExternalStore(
    (listener: () => void) => {
      if (!isReady || api == null) {
        return () => {};
      }
      return subscribeWorkflowRun(workspaceId!, runId!, {
        api,
        pollWhileActive: input.pollWhileActive,
        pollAfterTerminal: input.pollAfterTerminal,
      }, listener);
    },
    () => {
      if (!isReady) {
        return IDLE_SNAPSHOT;
      }
      return getWorkflowRunSnapshot(workspaceId!, runId!);
    }
  );

  // Guard against stale snapshots from a different run (shouldn't happen with
  // per-key cache entries, but kept for defensive parity with the old hook).
  if (snapshot.run != null && runId != null && snapshot.run.id !== runId) {
    return { run: null, loading: snapshot.loading, error: snapshot.error };
  }

  return snapshot;
}
