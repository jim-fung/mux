import type { ComponentType } from "react";
import { within, expect } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { APIClient } from "@/browser/contexts/API";
import { HeadroomStatsSection } from "./HeadroomStatsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/HeadroomStatsSection",
  component: HeadroomStatsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Build a mock headroom API namespace parameterized on proxy-running status and
 * the stats payload. The shared createMockORPCClient has no headroom namespace,
 * so stories inject one here.
 */
function mockHeadroomStatsApi(
  statusOverrides: Record<string, unknown>,
  stats: Record<string, unknown> | null
): APIClient["headroom"] {
  const status = {
    enabled: true,
    installed: true,
    provisioning: "installed",
    proxyRunning: true,
    proxyBaseUrl: "http://127.0.0.1:8787",
    port: 8787,
    runtimeMethod: "uv",
    lastError: null,
    mode: "off",
    autoProvision: true,
    includeMl: false,
    outputShaper: false,
    telemetry: false,
    memoryEnabled: false,
    perProvider: {},
    ...statusOverrides,
  };
  return {
    getStatus: () => Promise.resolve(status),
    getStats: () => Promise.resolve(stats),
  } as unknown as APIClient["headroom"];
}

/** APIClient with a headroom namespace injected for the stats section. */
function setupHeadroomStatsStory(
  statusOverrides: Record<string, unknown> = {},
  stats: Record<string, unknown> | null = null
): APIClient {
  return {
    ...setupSettingsStory({}),
    headroom: mockHeadroomStatsApi(statusOverrides, stats),
  };
}

const FULL_STATS = {
  totalRequests: 1284,
  tokensSaved: 982_311,
  savingsPercent: 71.4,
  requestsCompressed: 1284,
  routeCounts: {
    user_msg: 200,
    system_msg: 50,
    small: 400,
    non_string: 300,
    cache_hit: 334,
  },
  persistentTokensSaved: 5_120_998,
  persistentRequests: 6731,
};

/** Populated stats — proxy running with session + persistent traffic. */
export const Default: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupHeadroomStatsStory({}, FULL_STATS)}>
      <HeadroomStatsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Headroom Stats");
    // Session + Persistent groups both render.
    await canvas.findByText("Session");
    await canvas.findByText("Persistent");
    // Reduction is unique to the Session group.
    await canvas.findByText("Reduction");
    await canvas.findByText("71.4%");
  },
};

/** Proxy running but no traffic yet — friendly empty state. */
export const Empty: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupHeadroomStatsStory(
          {},
          {
            totalRequests: null,
            tokensSaved: null,
            savingsPercent: null,
            persistentTokensSaved: null,
            persistentRequests: null,
          }
        )
      }
    >
      <HeadroomStatsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No compression stats yet");
  },
};

/** Proxy running with real traffic but compressing nothing — the "isn't doing
 *  anything" failure mode. Asserts the amber no-op warning renders. */
export const NoOp: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupHeadroomStatsStory(
          {},
          {
            totalRequests: 1284,
            tokensSaved: 0,
            savingsPercent: 0,
            requestsCompressed: 0,
            routeCounts: {
              user_msg: 600,
              system_msg: 200,
              small: 300,
              non_string: 184,
              cache_hit: 0,
            },
            persistentTokensSaved: 0,
            persistentRequests: 0,
          }
        )
      }
    >
      <HeadroomStatsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Headroom is attached but hasn't compressed anything");
    // The breakdown of why messages were skipped must render.
    await canvas.findByText(/protected/);
  },
};

/** Proxy not running — stats unavailable. */
export const NotRunning: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupHeadroomStatsStory({ proxyRunning: false }, null)}>
      <HeadroomStatsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Proxy not running");
  },
};

/** Fixed-width decorator forcing a phone-width render (test-runner ignores
 *  chromatic modes + globals.viewport, so the play must force narrow itself). */
function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 375, overflow: "hidden" }} data-testid="phone-frame">
      <Story />
    </div>
  );
}

/** Populated stats at mobile width — asserts no horizontal overflow from the
 *  stat-tile grid (the failure mode AGENTS.md warns about). */
export const Mobile: Story = {
  decorators: [PhoneWidthDecorator],
  parameters: {
    chromatic: { modes: { mobile: { width: 375, height: 1200 } } },
  },
  render: () => (
    <SettingsSectionStory setup={() => setupHeadroomStatsStory({}, FULL_STATS)}>
      <HeadroomStatsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Reduction");
    // Responsive invariant: the phone frame must not overflow horizontally.
    const frame = canvasElement.querySelector('[data-testid="phone-frame"]');
    if (frame instanceof HTMLElement) {
      await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    }
  },
};
