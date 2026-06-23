import { z } from "zod";

/**
 * Headroom integration configuration.
 *
 * Headroom (https://github.com/headroomlabs-ai/headroom) is a context-compression
 * layer that sits between Mux and LLM providers. It runs as a local Python proxy
 * (`headroom proxy`) that compresses tool outputs, logs, files, and conversation
 * history before they reach the model — 60-95% fewer tokens with the same answers.
 *
 * Two integration levers, selectable per provider:
 *  - "middleware": a Vercel AI SDK LanguageModelV3Middleware calls the proxy's
 *    `/v1/compress` endpoint and rewrites the prompt in-process. Works with ALL
 *    providers and wire formats (provider-agnostic).
 *  - "proxy": the provider's baseURL is pointed at the Headroom proxy, which
 *    compresses + forwards. Only valid for Anthropic (/v1/messages) and
 *    OpenAI chat-completions; breaks Responses/WebSocket/Google/Bedrock.
 *
 * Mux auto-provisions an isolated Python venv (`~/.mux/headroom/`) and installs
 * `headroom-ai[proxy]` there, then launches and supervises the proxy. This is the
 * first "integration" of its kind in Mux — there is no generic plugin system yet.
 */
export const HeadroomModeSchema = z.enum(["off", "middleware", "proxy"]);

export type HeadroomMode = z.infer<typeof HeadroomModeSchema>;

/**
 * Fine-grained proxy settings surfaced in the Settings "Advanced" panel.
 *
 * These map 1:1 to real headroom proxy CLI flags / env vars (verified from the
 * official Proxy + Configuration docs). Headroom's named per-algorithm weights
 * (SmartCrusher / CacheAligner / IntelligentContext ScoringWeights) are
 * library/SDK-only and cannot be driven through the proxy, so they are NOT here;
 * power users can reach anything via customEnv / extraArgs.
 */
export const HeadroomAdvancedConfigSchema = z.object({
  /** --no-intelligent-context disables it; default true uses IntelligentContextManager. */
  intelligentContext: z.boolean().default(true),
  /** --no-intelligent-scoring disables multi-factor importance scoring. */
  intelligentScoring: z.boolean().default(true),
  /** --no-compress-first skips trying deeper compression before dropping messages. */
  compressFirst: z.boolean().default(true),
  /** --no-optimize disables optimization entirely (passthrough mode). */
  optimize: z.boolean().default(true),
  /** --no-cache disables semantic caching. */
  semanticCache: z.boolean().default(true),
  /** --llmlingua enables LLMLingua-2 ML compression (~2GB, ~1GB RAM, 10-30s cold start). */
  llmlingua: z.boolean().default(false),
  /** --llmlingua-device auto|cuda|cpu|mps. */
  llmlinguaDevice: z.enum(["auto", "cuda", "cpu", "mps"]).default("auto"),
  /** --llmlingua-rate: fraction to KEEP (0-1, e.g. 0.3 keeps 30%). */
  llmlinguaRate: z.number().min(0).max(1).default(0.3),
  /** --budget: daily spend cap in USD (null = no cap). */
  budgetUsd: z.number().nullable().default(null),
  /** HEADROOM_OUTPUT_HOLDOUT: fraction (0-1) of conversations left unshaped as control. */
  outputHoldout: z.number().min(0).max(1).default(0),
  /** HEADROOM_CONTEXT_TOOL: rtk (default) or lean-ctx. */
  contextTool: z.enum(["rtk", "lean-ctx"]).default("rtk"),
  /** HEADROOM_LOG_LEVEL. */
  logLevel: z.enum(["DEBUG", "INFO", "WARNING", "ERROR"]).default("INFO"),
  /** Free-form KEY=VALUE env overrides applied last (power users win). Applied via
   *  argv-less spawn, so values are passed through as-is (no shell expansion). */
  customEnv: z.record(z.string(), z.string()).default({}),
  /** Extra CLI args appended verbatim to the headroom proxy command (for future flags). */
  extraArgs: z.array(z.string()).default([]),
});

export type HeadroomAdvancedConfig = z.infer<typeof HeadroomAdvancedConfigSchema>;

/** All advanced defaults populated explicitly (avoids TS2769 on nested .default()). */
export const HEADROOM_ADVANCED_DEFAULTS: HeadroomAdvancedConfig = {
  intelligentContext: true,
  intelligentScoring: true,
  compressFirst: true,
  optimize: true,
  semanticCache: true,
  llmlingua: false,
  llmlinguaDevice: "auto",
  llmlinguaRate: 0.3,
  budgetUsd: null,
  outputHoldout: 0,
  contextTool: "rtk",
  logLevel: "INFO",
  customEnv: {},
  extraArgs: [],
};

/**
 * Per-workspace Headroom override, layered on the global HeadroomConfig.
 *
 * Sparse like the goalDefaults/heartbeat pattern: each field is nullable and
 * `null` means "follow the global default". When every field is null the whole
 * record is dropped from config.json so a workspace is indistinguishable from one
 * that never had an override.
 *
 * Phase 1 surfaces only routing-level fields (enabled / mode / perProvider) — these
 * resolve per-request at model-build time on the shared global proxy, no new
 * process needed. Process-level knobs (advanced, telemetry, etc.) require the
 * proxy pool (Phase 2) and will be added there.
 */
export const HeadroomWorkspaceOverrideSchema = z.object({
  /** Overrides the global enabled flag for this workspace. null = inherit. */
  enabled: z.boolean().nullable(),
  /** Overrides the global routing mode. null = inherit. */
  mode: HeadroomModeSchema.nullable(),
  /** Overrides the global per-provider map. null = inherit. */
  perProvider: z.record(z.string(), HeadroomModeSchema).nullable(),
  // --- Process-level fields (require the proxy pool — Phase 2). A workspace
  //     whose process config differs from the global default gets its own proxy
  //     process. Each replaces wholesale; null = inherit the global value.
  outputShaper: z.boolean().nullable(),
  telemetry: z.boolean().nullable(),
  memoryEnabled: z.boolean().nullable(),
  includeMl: z.boolean().nullable(),
  /** Replaces the global advanced block wholesale when set. null = inherit. */
  advanced: HeadroomAdvancedConfigSchema.nullable(),
});

export type HeadroomWorkspaceOverride = z.infer<typeof HeadroomWorkspaceOverrideSchema>;

export const HeadroomConfigSchema = z.object({
  /** Master switch. When false, no proxy is started and no middleware is attached. */
  enabled: z.boolean().default(false),
  /** If true, Mux creates a venv and installs headroom-ai itself. If false, the
   *  user is expected to run `headroom proxy` manually at `proxyBaseUrl`. */
  autoProvision: z.boolean().default(true),
  /** Global default routing mode. Per-provider overrides live in `perProvider`. */
  mode: HeadroomModeSchema.default("off"),
  /** Per-provider override keyed by canonical provider name (e.g. "anthropic").
   *  Falls back to the global `mode` when absent. */
  perProvider: z.record(z.string(), HeadroomModeSchema).default({}),
  /** Install headroom-ai[ml] for Kompress text compression (adds ~hundreds of MB
   *  + ML model downloads). Opt-in; [proxy] alone covers JSON/logs/code/diffs. */
  includeMl: z.boolean().default(false),
  /** When null, Mux launches the proxy on a random loopback port. When set, Mux
   *  connects to this base URL instead of managing its own proxy process. */
  proxyBaseUrl: z.string().nullable().default(null),
  /** Whether to enable Headroom's anonymous telemetry (off by default for privacy). */
  telemetry: z.boolean().default(false),
  /** Enable output-token shaping (HEADROOM_OUTPUT_SHAPER) — trims verbosity. */
  outputShaper: z.boolean().default(false),
  /** Cross-agent memory store enable/disable. */
  memory: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  /** Fine-grained proxy knobs surfaced in the Advanced settings panel. */
  advanced: HeadroomAdvancedConfigSchema.default(HEADROOM_ADVANCED_DEFAULTS),
});

export type HeadroomConfig = z.infer<typeof HeadroomConfigSchema>;
