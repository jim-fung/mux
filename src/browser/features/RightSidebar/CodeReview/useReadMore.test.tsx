import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import type { DiffHunk } from "@/common/types/review";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { installDom } from "../../../../../tests/ui/dom";
import { useReadMore } from "./useReadMore";

const ACTIVE_WORKSPACE_ID = "workspace-read-more-active";
const OTHER_WORKSPACE_ID = "workspace-read-more-other";

const TEST_HUNK: DiffHunk = {
  id: "hunk-1",
  filePath: "project-a/src/example.ts",
  oldStart: 5,
  oldLines: 3,
  newStart: 5,
  newLines: 4,
  content: " context\n-old\n+new\n",
  header: "@@ -5,3 +5,4 @@",
};

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
    projects: [
      { projectName: "project-a", projectPath: "/tmp/project-a" },
      { projectName: "project-b", projectPath: "/tmp/project-b" },
    ],
    ...overrides,
  };
}

const wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
  <APIProvider client={{} as APIClient}>{props.children}</APIProvider>
);

describe("useReadMore", () => {
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

    const hook = renderHook(
      () => {
        renderCount += 1;
        return useReadMore({
          hunk: TEST_HUNK,
          hunkId: TEST_HUNK.id,
          workspaceId: ACTIVE_WORKSPACE_ID,
          diffBase: "origin/main",
          includeUncommitted: true,
        });
      },
      { wrapper }
    );

    expect(renderCount).toBe(1);
    expect(hook.result.current.readMore).toEqual({ up: 0, down: 0 });

    act(() => {
      otherWorkspaceMetadata = createWorkspaceMetadata(OTHER_WORKSPACE_ID, { title: "changed" });
      getWorkspaceStoreRaw().syncWorkspaces(
        new Map([
          [ACTIVE_WORKSPACE_ID, activeWorkspaceMetadata],
          [OTHER_WORKSPACE_ID, otherWorkspaceMetadata],
        ])
      );
    });

    expect(renderCount).toBe(1);

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

    expect(renderCount).toBeGreaterThan(1);
  });
});
