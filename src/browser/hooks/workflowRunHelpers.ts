import { isActiveWorkflowRunStatus, type WorkflowRunRecord } from "@/common/types/workflow";

function getWorkflowRunTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getLatestWorkflowEventSequence(run: WorkflowRunRecord | null | undefined): number {
  return run?.events.reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0) ?? 0;
}

function compareWorkflowRunSnapshots(left: WorkflowRunRecord, right: WorkflowRunRecord): number {
  const leftUpdatedAt = getWorkflowRunTimestamp(left.updatedAt);
  const rightUpdatedAt = getWorkflowRunTimestamp(right.updatedAt);
  if (leftUpdatedAt != null && rightUpdatedAt != null && leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }
  if (leftUpdatedAt != null && rightUpdatedAt == null) {
    return 1;
  }
  if (leftUpdatedAt == null && rightUpdatedAt != null) {
    return -1;
  }
  return getLatestWorkflowEventSequence(left) - getLatestWorkflowEventSequence(right);
}

export function getNewestWorkflowRunSnapshot(
  current: WorkflowRunRecord | null,
  next: WorkflowRunRecord | null
): WorkflowRunRecord | null {
  if (next == null) {
    return current;
  }
  if (current == null || current.id !== next.id) {
    return next;
  }
  return compareWorkflowRunSnapshots(current, next) > 0 ? current : next;
}

export function shouldContinueWorkflowRunPolling(input: {
  pollWhileActive?: boolean;
  pollAfterTerminal?: boolean;
  run: WorkflowRunRecord | null;
}): boolean {
  if (input.pollWhileActive !== true) {
    return false;
  }
  if (input.pollAfterTerminal === true) {
    return true;
  }
  if (input.run == null) {
    return true;
  }
  return isActiveWorkflowRunStatus(input.run.status);
}
