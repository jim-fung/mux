import type { ComponentType } from "react";
import { within, expect } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { APIClient } from "@/browser/contexts/API";
import { HeadroomWorkspaceEditor } from "./HeadroomWorkspaceEditor.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/HeadroomWorkspaceEditor",
  component: HeadroomWorkspaceEditor,
};

export default meta;
type Story = StoryObj<typeof meta>;

const SPARSE_NULL = {
  enabled: null,
  mode: null,
  perProvider: null,
  outputShaper: null,
  telemetry: null,
  memoryEnabled: null,
  includeMl: null,
  advanced: null,
};

/** Build a mock API that returns a given override + effective routing. */
function mockApi(
  override: typeof SPARSE_NULL | null,
  effective: { enabled: boolean; mode: string; perProvider: Record<string, string> }
): APIClient {
  const headroom = {
    getWorkspaceHeadroom: () => Promise.resolve({ override, effective }),
    setWorkspaceHeadroom: () => Promise.resolve(undefined),
    clearWorkspaceHeadroom: () => Promise.resolve(undefined),
  };
  return { ...setupSettingsStory({}), headroom } as unknown as APIClient;
}

/** All fields inherited from global — shows "Inherited" badges everywhere. */
export const AllInherited: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() => mockApi(null, { enabled: true, mode: "proxy", perProvider: {} })}
    >
      <HeadroomWorkspaceEditor workspaceId="ws1" />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Enable Headroom");
    // No override => all "Inherited" badges should show.
    await canvas.findByText("Inherited");
  },
};

/** enabled overridden to false + mode overridden to proxy — badges hidden,
 *  "Reset to global" appears because an override exists. */
export const Overridden: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        mockApi(Object.assign({}, SPARSE_NULL, { enabled: false, mode: "proxy" }), {
          enabled: false,
          mode: "proxy",
          perProvider: {},
        })
      }
    >
      <HeadroomWorkspaceEditor workspaceId="ws1" />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Reset to global");
  },
};

function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 375, overflow: "hidden" }} data-testid="phone-frame">
      <Story />
    </div>
  );
}

/** Editor at mobile width — asserts no horizontal overflow. */
export const Mobile: Story = {
  decorators: [PhoneWidthDecorator],
  parameters: {
    chromatic: { modes: { mobile: { width: 375, height: 900 } } },
  },
  render: () => (
    <SettingsSectionStory
      setup={() =>
        mockApi(Object.assign({}, SPARSE_NULL, { mode: "proxy" }), {
          enabled: true,
          mode: "proxy",
          perProvider: {},
        })
      }
    >
      <HeadroomWorkspaceEditor workspaceId="ws1" />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Compression mode");
    const frame = canvasElement.querySelector('[data-testid="phone-frame"]');
    if (frame instanceof HTMLElement) {
      await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    }
  },
};
