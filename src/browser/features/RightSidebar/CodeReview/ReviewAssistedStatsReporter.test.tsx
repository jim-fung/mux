import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { installDom } from "../../../../../tests/ui/dom";
import { ReviewAssistedStatsReporter } from "./ReviewPanel";

const ACTIVE_WORKSPACE_ID = "review-reporter-active";
const OTHER_WORKSPACE_ID = "review-reporter-other";

function createWorkspaceMetadata(
  workspaceId: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: `/tmp/project/${workspaceId}`,
    runtimeConfig: { type: "local" },
    createdAt: "2026-07-01T00:00:00.000Z",
    projects: [{ projectName: "project-a", projectPath: "/tmp/project-a" }],
    ...overrides,
  };
}

const wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
  <APIProvider client={{} as APIClient}>{props.children}</APIProvider>
);

describe("ReviewAssistedStatsReporter", () => {
  let cleanupDom: (() => void) | null = null;
  let activeWorkspaceMetadata: FrontendWorkspaceMetadata;
  let otherWorkspaceMetadata: FrontendWorkspaceMetadata;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    getWorkspaceStoreRaw().dispose();
    activeWorkspaceMetadata = createWorkspaceMetadata(ACTIVE_WORKSPACE_ID);
    otherWorkspaceMetadata = createWorkspaceMetadata(OTHER_WORKSPACE_ID);
    getWorkspaceStoreRaw().syncWorkspaces(
      new Map([
        [ACTIVE_WORKSPACE_ID, activeWorkspaceMetadata],
        [OTHER_WORKSPACE_ID, otherWorkspaceMetadata],
      ])
    );
  });

  afterEach(() => {
    cleanup();
    getWorkspaceStoreRaw().dispose();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("does not rerender for unrelated workspace metadata updates", () => {
    let renderCount = 0;

    render(
      <ReviewAssistedStatsReporter
        workspaceId={ACTIVE_WORKSPACE_ID}
        workspacePath="/tmp/project/workspace"
        projectPath="/tmp/project"
        onUnreadAssistedChange={() => undefined}
        onRender={() => {
          renderCount += 1;
        }}
      />,
      { wrapper }
    );

    const initialRenderCount = renderCount;
    expect(initialRenderCount).toBeGreaterThan(0);

    act(() => {
      otherWorkspaceMetadata = createWorkspaceMetadata(OTHER_WORKSPACE_ID, { title: "changed" });
      getWorkspaceStoreRaw().syncWorkspaces(
        new Map([
          [ACTIVE_WORKSPACE_ID, activeWorkspaceMetadata],
          [OTHER_WORKSPACE_ID, otherWorkspaceMetadata],
        ])
      );
    });

    expect(renderCount).toBe(initialRenderCount);

    act(() => {
      activeWorkspaceMetadata = createWorkspaceMetadata(ACTIVE_WORKSPACE_ID, {
        parentWorkspaceId: "parent-workspace",
      });
      getWorkspaceStoreRaw().syncWorkspaces(
        new Map([
          [ACTIVE_WORKSPACE_ID, activeWorkspaceMetadata],
          [OTHER_WORKSPACE_ID, otherWorkspaceMetadata],
        ])
      );
    });

    expect(renderCount).toBeGreaterThan(initialRenderCount);
  });
});
