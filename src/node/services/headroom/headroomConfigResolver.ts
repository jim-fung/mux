import type { HeadroomConfig } from "@/common/config/schemas/headroom";
import type { HeadroomWorkspaceOverride } from "@/common/config/schemas/headroom";

/**
 * Resolve the effective HeadroomConfig for a workspace by layering its sparse
 * per-workspace override on top of the global config (workspace wins).
 *
 * Routing fields (enabled / mode / perProvider) resolve per-request at
 * model-build time. Process fields (telemetry / outputShaper / memoryEnabled /
 * advanced) shape the spawned proxy command; when they differ from the global
 * default the proxy pool (Phase 2) gives that workspace its own process.
 *
 * Pure + side-effect-free so it is trivially unit-testable and callable from both
 * the request path and the IPC layer.
 */
export function resolveHeadroomConfig(
  global: HeadroomConfig,
  override: HeadroomWorkspaceOverride | null | undefined
): HeadroomConfig {
  if (!override) return global;
  const resolved: HeadroomConfig = { ...global };
  // null => inherit global; a present value overrides.
  if (override.enabled != null) resolved.enabled = override.enabled;
  if (override.mode != null) resolved.mode = override.mode;
  if (override.perProvider != null) resolved.perProvider = override.perProvider;
  if (override.telemetry != null) resolved.telemetry = override.telemetry;
  if (override.outputShaper != null) resolved.outputShaper = override.outputShaper;
  if (override.memoryEnabled != null)
    resolved.memory = { ...resolved.memory, enabled: override.memoryEnabled };
  if (override.includeMl != null) resolved.includeMl = override.includeMl;
  if (override.advanced != null) resolved.advanced = override.advanced;
  return resolved;
}

/**
 * Deterministic key for the process-level portion of a HeadroomConfig. Two
 * effective configs that produce the SAME key share one proxy process (via the
 * pool); a differing key spawns a separate process. Only the fields that shape
 * the proxy command participate — routing fields (enabled/mode/perProvider) do
 * not, and neither does includeMl (a provisioning concern, not a per-process arg).
 */
export function headroomProcessKey(effective: HeadroomConfig): string {
  return stableStringify({
    telemetry: effective.telemetry,
    outputShaper: effective.outputShaper,
    memoryEnabled: effective.memory.enabled,
    advanced: effective.advanced,
  });
}

/** JSON.stringify with sorted object keys so key order never affects the digest. */
function stableStringify(value: unknown): string {
  const replacer = (_k: string, v: unknown): unknown => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(value, replacer as (this: unknown, key: string, value: unknown) => unknown);
}
