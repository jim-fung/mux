import type { HeadroomAdvancedConfig } from "./schemas/headroom";

/**
 * Pure projection of Headroom process-level settings onto the `headroom proxy`
 * argv + env. Lives in src/common so the live-spawn path (HeadroomProxyProcess),
 * the previewCommand IPC endpoint, and the browser Settings preview ALL share a
 * single definition — the UI can never drift from what actually spawns.
 *
 * This module has NO node-only dependencies (no spawn/process/fs), so it is safe
 * to import from the renderer.
 */

/** All process-level inputs that shape the headroom proxy command line + env. */
export interface ProxyCommandSpec {
  telemetry: boolean;
  outputShaper: boolean;
  memoryEnabled: boolean;
  advanced: HeadroomAdvancedConfig;
}

/**
 * Build the headroom proxy argv + headroom-specific env deltas.
 *
 * `portStr` is a placeholder ("$PORT") for preview; the live spawn passes the
 * real port. Returns ONLY headroom-specific env overrides (NOT process.env), so a
 * preview never leaks host secrets and the spawn merges them onto process.env.
 *
 * Flags/env are only pushed when the value DEVIATES from the Headroom default (the
 * proxy defaults already match our schema defaults), so default config produces a
 * clean invocation with no noise.
 *
 * SECURITY: customEnv / extraArgs are applied LAST so power-user overrides win.
 * The spawn uses an argv array (no shell), so there is no shell-injection vector —
 * values are passed verbatim to the headroom process. customEnv CAN set upstream
 * URLs / API keys; this is the intentional power-user surface documented in the
 * Advanced panel.
 */
export function buildProxyCommand(
  spec: ProxyCommandSpec,
  portStr = "$PORT"
): { argv: string[]; env: Record<string, string> } {
  const argv = ["proxy", "--host", "127.0.0.1", "--port", portStr];
  const env: Record<string, string> = {};

  // Base toggles.
  if (!spec.telemetry) {
    argv.push("--no-telemetry");
    env.HEADROOM_TELEMETRY = "off";
  }
  if (spec.outputShaper) env.HEADROOM_OUTPUT_SHAPER = "1";
  if (spec.memoryEnabled) env.HEADROOM_MEMORY_ENABLED = "1";
  // Mux invariant: never let the proxy inject its `headroom_retrieve` tool.
  // Mux has its own tool system and cannot resolve that tool, so in proxy mode
  // the model would call it and error. /v1/compress (SharedContext) is
  // compression-only and injects nothing upstream, so this is harmless there.
  argv.push("--no-ccr-inject-tool");
  env.HEADROOM_NO_CCR_INJECT_TOOL = "1";

  applyAdvanced(argv, env, spec.advanced);
  return { argv, env };
}

/** Render the preview as a single shell-like command line for display. */
export function formatProxyCommand(spec: ProxyCommandSpec): string {
  const { argv, env } = buildProxyCommand(spec);
  const envPrefix =
    Object.keys(env).length > 0
      ? Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ") + " "
      : "";
  return envPrefix + "headroom " + argv.join(" ");
}

/** Map the Advanced settings block onto headroom proxy CLI flags + env vars. */
export function applyAdvanced(
  argv: string[],
  env: Record<string, string>,
  adv: HeadroomAdvancedConfig
): void {
  // Context-management toggles (push only the negation flag when disabled).
  if (!adv.intelligentContext) argv.push("--no-intelligent-context");
  if (!adv.intelligentScoring) argv.push("--no-intelligent-scoring");
  if (!adv.compressFirst) argv.push("--no-compress-first");

  // Compression / cache toggles.
  if (!adv.optimize) argv.push("--no-optimize");
  if (!adv.semanticCache) argv.push("--no-cache");

  // LLMLingua ML compression.
  if (adv.llmlingua) {
    argv.push(
      "--llmlingua",
      "--llmlingua-device",
      adv.llmlinguaDevice,
      "--llmlingua-rate",
      String(adv.llmlinguaRate)
    );
  }

  // Daily budget cap (USD).
  if (adv.budgetUsd != null) {
    argv.push("--budget", String(adv.budgetUsd));
  }

  // Env-only knobs.
  if (adv.outputHoldout > 0) env.HEADROOM_OUTPUT_HOLDOUT = String(adv.outputHoldout);
  env.HEADROOM_CONTEXT_TOOL = adv.contextTool;
  env.HEADROOM_LOG_LEVEL = adv.logLevel;

  // Power-user overrides — applied last so they take precedence over everything above.
  for (const [key, value] of Object.entries(adv.customEnv)) {
    env[key] = value;
  }
  argv.push(...adv.extraArgs);
}
