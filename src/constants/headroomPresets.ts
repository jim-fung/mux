import type { HeadroomAdvancedConfig } from "@/common/config/schemas/headroom";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";

/**
 * Named starting points for the Compression-tuning panel. Selecting a preset
 * merges its patch into the current draft and immediately persists + restarts
 * the proxy (see HeadroomSection.applyPreset). Presets only touch algorithm-level
 * knobs; power-user escapes (customEnv / extraArgs) are intentionally left
 * untouched.
 */
export interface HeadroomPreset {
  id: string;
  label: string;
  description: string;
  patch: Partial<HeadroomAdvancedConfig>;
}

export const HEADROOM_PRESETS: HeadroomPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Headroom's defaults — quality-aware compression with caching.",
    patch: {
      intelligentContext: HEADROOM_ADVANCED_DEFAULTS.intelligentContext,
      intelligentScoring: HEADROOM_ADVANCED_DEFAULTS.intelligentScoring,
      compressFirst: HEADROOM_ADVANCED_DEFAULTS.compressFirst,
      optimize: HEADROOM_ADVANCED_DEFAULTS.optimize,
      semanticCache: HEADROOM_ADVANCED_DEFAULTS.semanticCache,
      llmlingua: false,
    },
  },
  {
    id: "max-savings",
    label: "Max savings",
    description: "Every aggressive lever on, including ML compression (high RAM cost).",
    patch: {
      intelligentContext: true,
      intelligentScoring: true,
      compressFirst: true,
      optimize: true,
      semanticCache: true,
      llmlingua: true,
    },
  },
  {
    id: "low-overhead",
    label: "Low overhead",
    description: "Disable expensive scoring + caching for lowest latency.",
    patch: {
      intelligentScoring: false,
      semanticCache: false,
      llmlingua: false,
    },
  },
  {
    id: "debug",
    label: "Debug",
    description: "Verbose logging so proxy behavior is fully visible.",
    patch: {
      logLevel: "DEBUG",
    },
  },
];
