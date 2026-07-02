import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "../../../tests/ui/dom";
import {
  CommandRegistryProvider,
  useCommandRegistry,
} from "@/browser/contexts/CommandRegistryContext";

function RecentHarness() {
  const registry = useCommandRegistry();

  return (
    <>
      <button
        type="button"
        onClick={() => {
          registry.addRecent("first");
          registry.addRecent("second");
        }}
      >
        Add recents
      </button>
      <output data-testid="recent-order">{registry.recent.join(",")}</output>
    </>
  );
}

describe("CommandRegistryProvider", () => {
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

  test("keeps back-to-back recent updates instead of dropping the earlier action", async () => {
    const view = render(
      <CommandRegistryProvider>
        <RecentHarness />
      </CommandRegistryProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Add recents" }));

    await waitFor(() => {
      expect(view.getByTestId("recent-order").textContent).toBe("second,first");
    });
    expect(JSON.parse(window.localStorage.getItem("commandPalette:recent") ?? "[]")).toEqual([
      "second",
      "first",
    ]);
  });
});
