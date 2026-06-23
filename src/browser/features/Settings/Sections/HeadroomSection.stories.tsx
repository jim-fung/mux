import type { ComponentType } from "react";
import { within, userEvent, expect } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { APIClient } from "@/browser/contexts/API";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";
import { HeadroomSection } from "./HeadroomSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/HeadroomSection",
  component: HeadroomSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Build a mock headroom API namespace. The shared createMockORPCClient has no
 * headroom namespace, so stories inject one here to exercise the panel with
 * realistic status data.
 */
function mockHeadroomApi(
  status: Record<string, unknown>,
  workspaceOverrides: Array<{
    workspaceId: string;
    title: string | null;
    override: Record<string, unknown>;
  }> = []
): APIClient["headroom"] {
  const full = {
    enabled: true,
    installed: true,
    provisioning: "installed",
    proxyRunning: true,
    proxyBaseUrl: "http://127.0.0.1:8787",
    port: 8787,
    runtimeMethod: "uv",
    lastError: null,
    mode: "middleware",
    autoProvision: true,
    includeMl: false,
    outputShaper: false,
    telemetry: false,
    memoryEnabled: false,
    perProvider: {},
    advanced: HEADROOM_ADVANCED_DEFAULTS,
    ...status,
  };
  return {
    getStatus: () => Promise.resolve(full),
    getStats: () =>
      Promise.resolve({
        totalRequests: null,
        tokensSaved: null,
        savingsPercent: null,
        persistentTokensSaved: null,
        persistentRequests: null,
      }),
    provision: () => Promise.resolve(full),
    restart: () => Promise.resolve(full),
    setConfig: () => Promise.resolve(undefined),
    learn: () => Promise.resolve({ output: "" }),
    registerMcp: () => Promise.resolve({ success: false, command: null }),
    installLlmlingua: () => Promise.resolve({ success: true, message: "" }),
    previewCommand: () => Promise.resolve({ argv: ["proxy", "--host", "127.0.0.1"], env: {} }),
    listWorkspaceHeadroomOverrides: () => Promise.resolve(workspaceOverrides),
    getWorkspaceHeadroom: () => Promise.resolve(null),
    setWorkspaceHeadroom: () => Promise.resolve(undefined),
    clearWorkspaceHeadroom: () => Promise.resolve(undefined),
  } as unknown as APIClient["headroom"];
}

/** Setup a settings client with a headroom namespace injected. */
function setupHeadroomStory(
  status: Record<string, unknown>,
  workspaceOverrides?: Parameters<typeof mockHeadroomApi>[1]
): APIClient {
  return { ...setupSettingsStory({}), headroom: mockHeadroomApi(status, workspaceOverrides) };
}

/**
 * Default state — Headroom not installed, proxy not running.
 * The component gracefully degrades when the headroom API is unavailable.
 */
export const Default: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <HeadroomSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The heading should render even without a running proxy.
    await canvas.findByText("Headroom Compression");
  },
};

/**
 * Installed + the Advanced compression-tuning panel expanded. Exercises the
 * fine-grained proxy knobs (intelligent context, scoring, LLMLingua, etc.).
 */
export const AdvancedPanel: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupHeadroomStory({})}>
      <HeadroomSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Headroom Compression");
    // Expand the tuning panel.
    const toggle = await canvas.findByText("Compression tuning");
    await userEvent.click(toggle);
    // A control from the expanded panel should now be visible.
    await canvas.findByText("Intelligent context");
    await canvas.findByText("Enable LLMLingua-2");
  },
};

/** All-null sparse override shape reused across stories. */
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

/**
 * The Per-workspace overrides overview with two seeded workspaces. Verifies the
 * list renders populated entries so global Settings stays the single overview.
 */
export const WorkspaceOverrides: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupHeadroomStory({}, [
          {
            workspaceId: "ws1",
            title: "feature/auth",
            override: Object.assign({}, SPARSE_NULL, { enabled: false }),
          },
          {
            workspaceId: "ws2",
            title: "bugfix/cache",
            override: Object.assign({}, SPARSE_NULL, { mode: "proxy" }),
          },
        ])
      }
    >
      <HeadroomSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Per-workspace overrides");
    await canvas.findByText("feature/auth");
    await canvas.findByText("bugfix/cache");
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

/**
 * The Advanced panel at mobile width — asserts no horizontal overflow (the
 * failure mode AGENTS.md warns about: nowrap/auto-grid columns pushing off-screen).
 */
export const AdvancedPanelMobile: Story = {
  decorators: [PhoneWidthDecorator],
  parameters: {
    chromatic: { modes: { mobile: { width: 375, height: 1200 } } },
  },
  render: () => (
    <SettingsSectionStory setup={() => setupHeadroomStory({})}>
      <HeadroomSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Headroom Compression");
    const toggle = await canvas.findByText("Compression tuning");
    await userEvent.click(toggle);
    await canvas.findByText("Intelligent context");
    // Responsive invariant: the phone frame must not overflow horizontally.
    const frame = canvasElement.querySelector('[data-testid="phone-frame"]');
    if (frame instanceof HTMLElement) {
      await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    }
  },
};
