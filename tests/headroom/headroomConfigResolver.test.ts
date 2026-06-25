import { describe, expect, it } from "bun:test";
import {
  resolveHeadroomConfig,
  headroomProcessKey,
} from "@/node/services/headroom/headroomConfigResolver";
import type { HeadroomConfig, HeadroomWorkspaceOverride } from "@/common/config/schemas/headroom";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";

const globalConfig: HeadroomConfig = {
  enabled: true,
  autoProvision: true,
  mode: "off",
  perProvider: { openai: "proxy" },
  includeMl: false,
  proxyBaseUrl: null,
  telemetry: false,
  outputShaper: false,
  memory: { enabled: false, ttlSeconds: 3600, maxEntries: 200, compressThresholdTokens: 500 },
  advanced: HEADROOM_ADVANCED_DEFAULTS,
};

/** Build a full sparse override, defaulting every unspecified field to null. */
function overrideOf(partial: Partial<HeadroomWorkspaceOverride>): HeadroomWorkspaceOverride {
  return {
    enabled: null,
    mode: null,
    perProvider: null,
    outputShaper: null,
    telemetry: null,
    memoryEnabled: null,
    memoryTtlSeconds: null,
    memoryMaxEntries: null,
    memoryCompressThresholdTokens: null,
    includeMl: null,
    advanced: null,
    ...partial,
  };
}

describe("resolveHeadroomConfig", () => {
  it("returns the global config unchanged when there is no override", () => {
    expect(resolveHeadroomConfig(globalConfig, null)).toEqual(globalConfig);
    expect(resolveHeadroomConfig(globalConfig, undefined)).toEqual(globalConfig);
  });

  it("lets a workspace opt out via enabled=false", () => {
    const resolved = resolveHeadroomConfig(globalConfig, overrideOf({ enabled: false }));
    expect(resolved.enabled).toBe(false);
    // Untouched routing fields still come from global.
    expect(resolved.mode).toBe("off");
    expect(resolved.perProvider).toEqual({ openai: "proxy" });
  });

  it("overrides mode while keeping global enabled/perProvider", () => {
    const resolved = resolveHeadroomConfig(globalConfig, overrideOf({ mode: "proxy" }));
    expect(resolved.mode).toBe("proxy");
    expect(resolved.enabled).toBe(true);
  });

  it("overrides perProvider wholesale", () => {
    const resolved = resolveHeadroomConfig(
      globalConfig,
      overrideOf({ perProvider: { anthropic: "proxy" } })
    );
    expect(resolved.perProvider).toEqual({ anthropic: "proxy" });
  });

  it("null fields mean inherit (all-null override == no override)", () => {
    expect(resolveHeadroomConfig(globalConfig, overrideOf({}))).toEqual(globalConfig);
  });

  it("does not mutate the input global config", () => {
    const snapshot = { ...globalConfig, perProvider: { ...globalConfig.perProvider } };
    resolveHeadroomConfig(
      globalConfig,
      overrideOf({ enabled: false, mode: "off", perProvider: {} })
    );
    expect(globalConfig).toEqual(snapshot);
  });

  it("overlays process-level advanced wholesale when set", () => {
    const customAdvanced = { ...HEADROOM_ADVANCED_DEFAULTS, optimize: false, llmlingua: true };
    const resolved = resolveHeadroomConfig(globalConfig, overrideOf({ advanced: customAdvanced }));
    expect(resolved.advanced).toEqual(customAdvanced);
    expect(resolved.advanced.optimize).toBe(false);
  });

  it("headroomProcessKey is identical for same advanced, different for different", () => {
    const a = headroomProcessKey(globalConfig);
    const sameAdvanced = { ...globalConfig };
    const b = headroomProcessKey(sameAdvanced);
    expect(a).toBe(b);
    const diverged = resolveHeadroomConfig(globalConfig, overrideOf({ telemetry: true }));
    expect(headroomProcessKey(diverged)).not.toBe(a);
  });
});
