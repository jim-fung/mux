import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

import { ThresholdSlider } from "./ThresholdSlider";

describe("ThresholdSlider", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("previews drag movement and commits the threshold once on pointer up", () => {
    const setThreshold = mock();
    const view = render(<ThresholdSlider config={{ threshold: 70, setThreshold }} />);

    const handle = view.getByTestId("auto-compaction-threshold-handle");
    const sliderRoot = handle.parentElement;
    expect(sliderRoot).toBeTruthy();
    if (sliderRoot == null) {
      throw new Error("Expected threshold slider handle to be mounted");
    }
    Object.defineProperty(sliderRoot, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 20,
        right: 100,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    fireEvent.pointerDown(handle, {
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 60,
    });
    expect(setThreshold).not.toHaveBeenCalled();
    expect(handle.style.left).toBe("calc(60% - 16px)");

    fireEvent.pointerMove(document, {
      pointerId: 7,
      buttons: 1,
      clientX: 85,
    });
    expect(setThreshold).not.toHaveBeenCalled();
    expect(handle.style.left).toBe("calc(85% - 16px)");

    fireEvent.pointerUp(document, {
      pointerId: 7,
      button: 0,
      buttons: 0,
      clientX: 85,
    });
    expect(setThreshold).toHaveBeenCalledTimes(1);
    expect(setThreshold).toHaveBeenCalledWith(85);
  });
});
