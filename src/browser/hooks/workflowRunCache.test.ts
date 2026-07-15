import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  subscribeWorkflowRun,
  getWorkflowRunSnapshot,
  _clearWorkflowRunCacheForTests,
} from "./workflowRunCache";
import type { WorkflowRunRecord } from "@/common/types/workflow";

function createRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const base: WorkflowRunRecord = {
    id: "run-1",
    workspaceId: "ws-1",
    workflow: { name: "test", description: "Test workflow", scope: "project", executable: true },
    source: "test",
    sourceHash: "test",
    args: {},
    status: "running",
    createdAt: new Date().toISOString(),
    events: [],
    steps: [],
    updatedAt: new Date().toISOString(),
  };
  return Object.assign(base, overrides);
}

describe("workflowRunCache", () => {
  beforeEach(() => {
    _clearWorkflowRunCacheForTests();
  });

  afterEach(() => {
    _clearWorkflowRunCacheForTests();
  });

  test("two subscribers to the same run share a single getRun RPC", async () => {
    const getRunMock = mock(() => Promise.resolve(createRun()));
    const api: Parameters<typeof subscribeWorkflowRun>[2]["api"] = {
      workflows: { getRun: getRunMock },
    } as unknown as Parameters<typeof subscribeWorkflowRun>[2]["api"];

    const listener1 = mock();
    const listener2 = mock();

    const unsub1 = subscribeWorkflowRun("ws-1", "run-1", { api, pollWhileActive: true }, listener1);
    // Wait for the initial fetch triggered by the first subscriber.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const callsAfterFirstSub = getRunMock.mock.calls.length;
    expect(callsAfterFirstSub).toBe(1);

    // Second subscriber for the same run — should NOT trigger another fetch.
    const unsub2 = subscribeWorkflowRun("ws-1", "run-1", { api, pollWhileActive: true }, listener2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getRunMock.mock.calls.length).toBe(1);

    // Both subscribers see the same snapshot.
    const snap1 = getWorkflowRunSnapshot("ws-1", "run-1");
    expect(snap1.run?.id).toBe("run-1");
    expect(snap1.loading).toBe(false);

    unsub1();
    unsub2();
  });

  test("cleans up cache entry when the last subscriber unsubscribes", () => {
    const getRunMock = mock(() => Promise.resolve(createRun()));
    const api: Parameters<typeof subscribeWorkflowRun>[2]["api"] = {
      workflows: { getRun: getRunMock },
    } as unknown as Parameters<typeof subscribeWorkflowRun>[2]["api"];

    const unsub = subscribeWorkflowRun("ws-2", "run-2", { api, pollWhileActive: true }, mock());
    unsub();

    // After unsubscribe, snapshot should fall back to idle.
    const snap = getWorkflowRunSnapshot("ws-2", "run-2");
    expect(snap.run).toBeNull();
    expect(snap.loading).toBe(false);
  });
});
