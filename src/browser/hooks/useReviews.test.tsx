import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";

import { useReviewActions, useReviews } from "./useReviews";

const WORKSPACE_ID = "workspace-review-actions";

describe("useReviewActions", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("updates persisted review state without subscribing the action-only caller", () => {
    let actionRenderCount = 0;
    let stateRenderCount = 0;

    const actionHook = renderHook(() => {
      actionRenderCount += 1;
      return useReviewActions(WORKSPACE_ID);
    });
    const stateHook = renderHook(() => {
      stateRenderCount += 1;
      return useReviews(WORKSPACE_ID);
    });

    expect(actionRenderCount).toBe(1);
    expect(stateRenderCount).toBe(1);
    expect(stateHook.result.current.reviews).toEqual([]);

    let reviewId = "";
    act(() => {
      const review = actionHook.result.current.addReview({
        filePath: "src/example.ts",
        lineRange: "+10-12",
        selectedCode: "const example = true;",
        userNote: "Check this branch",
      });
      reviewId = review.id;
    });

    expect(actionRenderCount).toBe(1);
    expect(stateRenderCount).toBe(2);
    expect(stateHook.result.current.reviews).toHaveLength(1);
    expect(stateHook.result.current.attachedReviews).toHaveLength(1);
    expect(stateHook.result.current.getReview(reviewId)?.data.userNote).toBe("Check this branch");
  });
});
