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
});

export type HeadroomConfig = z.infer<typeof HeadroomConfigSchema>;
