/**
 * Headroom Section — Settings UI for the Headroom context-compression integration.
 *
 * Shows provisioning status, proxy health, token-savings stats, and the global
 * routing mode toggle. Config changes trigger a proxy restart via the backend.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, RotateCcw } from "lucide-react";
import type {
  HeadroomAdvancedConfig,
  HeadroomWorkspaceOverride,
} from "@/common/config/schemas/headroom";
import { HeadroomWorkspaceEditor } from "./HeadroomWorkspaceEditor";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";
import { formatProxyCommand } from "@/common/config/headroomProxyCommand";
import { HEADROOM_PRESETS } from "@/constants/headroomPresets";
import { Button } from "@/browser/components/Button/Button";
import { Switch } from "@/browser/components/Switch/Switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";

interface HeadroomStatus {
  enabled: boolean;
  installed: boolean;
  provisioning: string;
  proxyRunning: boolean;
  proxyBaseUrl: string | null;
  port: number | null;
  runtimeMethod: string;
  lastError: string | null;
  mode: string;
  autoProvision: boolean;
  includeMl: boolean;
  outputShaper: boolean;
  telemetry: boolean;
  memoryEnabled: boolean;
  perProvider: Record<string, string>;
  advanced: HeadroomAdvancedConfig;
}

interface HeadroomStats {
  totalRequests: number | null;
  tokensSaved: number | null;
  savingsPercent: number | null;
}

const MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "middleware", label: "Middleware (all providers)" },
  { value: "proxy", label: "Proxy (Anthropic + OpenAI chat)" },
];

/** Validate the in-progress tuning draft + custom-env text. Returns human errors;
 *  empty array means apply is safe. Bounds mirror the HeadroomAdvancedConfig schema. */
function validateTuning(adv: HeadroomAdvancedConfig, envText: string): string[] {
  const errors: string[] = [];
  if (adv.budgetUsd != null && adv.budgetUsd < 0) {
    errors.push("Daily budget must be 0 or greater.");
  }
  if (adv.llmlingua && (adv.llmlinguaRate < 0.05 || adv.llmlinguaRate > 1)) {
    errors.push("LLMLingua keep rate must be between 5% and 100%.");
  }
  if (adv.outputHoldout < 0 || adv.outputHoldout > 0.5) {
    errors.push("Output holdout must be between 0% and 50%.");
  }
  const seen = new Set<string>();
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      errors.push(`Env line missing "KEY=": "${trimmed}".`);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (seen.has(key)) errors.push(`Duplicate env key: "${key}".`);
    seen.add(key);
  }
  return errors;
}

async function doRestart(
  api: ReturnType<typeof useAPI>["api"],
  setStatus: (s: HeadroomStatus) => void
) {
  if (!api) return;
  const r = await api.headroom.restart();
  setStatus(r);
}

export function HeadroomSection() {
  const { api } = useAPI();
  const [status, setStatus] = useState<HeadroomStatus | null>(null);
  const [stats, setStats] = useState<HeadroomStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [perProvider, setPerProvider] = useState<Record<string, "off" | "middleware" | "proxy">>(
    {}
  );
  const [learnOutput, setLearnOutput] = useState<string | null>(null);
  const [learnLoading, setLearnLoading] = useState(false);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpRegistered, setMcpRegistered] = useState(false);
  const [showTuning, setShowTuning] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [workspaceOverrides, setWorkspaceOverrides] = useState<
    Array<{ workspaceId: string; title: string | null; override: HeadroomWorkspaceOverride }>
  >([]);
  const [expandedWorkspace, setExpandedWorkspace] = useState<string | null>(null);
  const [tuningDraft, setTuningDraft] = useState<HeadroomAdvancedConfig>(
    HEADROOM_ADVANCED_DEFAULTS
  );
  const [customEnvText, setCustomEnvText] = useState("");
  const [extraArgsText, setExtraArgsText] = useState("");
  const [tuningApplying, setTuningApplying] = useState(false);
  const [llmlinguaInstalling, setLlmlinguaInstalling] = useState(false);
  const [llmlinguaMessage, setLlmlinguaMessage] = useState<string | null>(null);

  async function refreshStatus() {
    if (!api) return;
    try {
      const s = await api.headroom.getStatus();
      setStatus(s);
      // Sync the tuning draft from live config (only when not actively editing).
      if (s.advanced) {
        setTuningDraft(s.advanced);
        setCustomEnvText(
          Object.entries(s.advanced.customEnv)
            .map(([k, v]) => k + "=" + v)
            .join("\n")
        );
        setExtraArgsText(s.advanced.extraArgs.join(" "));
      }
      if (s.perProvider)
        setPerProvider(s.perProvider as Record<string, "off" | "middleware" | "proxy">);
      const st = await api.headroom.getStats();
      setStats(st);
      setWorkspaceOverrides(await api.headroom.listWorkspaceHeadroomOverrides());
    } catch {
      // Non-fatal — just show stale status
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!api) return;
    void refreshStatus();
    // Poll stats every 10s while the proxy is running.
    const interval = setInterval(() => {
      if (status?.proxyRunning) {
        void refreshStatus();
      }
    }, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status?.proxyRunning]);

  async function toggleEnabled(checked: boolean) {
    if (!api) return;
    setStatus((prev) => (prev ? { ...prev, enabled: checked } : prev));
    await api.headroom.setConfig({ enabled: checked });
    if (checked) {
      await api.headroom.setConfig({ mode: "middleware" });
    }
    await refreshStatus();
  }

  async function changeMode(mode: "off" | "middleware" | "proxy") {
    if (!api) return;
    await api.headroom.setConfig({ mode });
    await refreshStatus();
  }

  async function handleProvision() {
    if (!api) return;
    setProvisioning(true);
    try {
      const result = await api.headroom.provision();
      setStatus(result);
    } finally {
      setProvisioning(false);
    }
  }

  async function toggleSubSetting(key: string, value: boolean) {
    if (!api) return;
    await api.headroom.setConfig({ [key]: value });
    await refreshStatus();
  }

  async function handleLearn(apply: boolean) {
    if (!api) return;
    setLearnLoading(true);
    try {
      const result = await api.headroom.learn({ apply });
      setLearnOutput(result.output);
    } catch (err) {
      setLearnOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLearnLoading(false);
    }
  }

  async function handleRegisterMcp() {
    if (!api) return;
    setMcpLoading(true);
    try {
      const result = await api.headroom.registerMcp();
      setMcpRegistered(result.success);
    } catch {
      setMcpRegistered(false);
    } finally {
      setMcpLoading(false);
    }
  }

  function updateTuning<K extends keyof HeadroomAdvancedConfig>(
    key: K,
    value: HeadroomAdvancedConfig[K]
  ) {
    setTuningDraft((prev) => ({ ...prev, [key]: value }));
  }

  /** Merge a preset's patch into the draft (no auto-apply). */
  function applyPreset(patch: Partial<HeadroomAdvancedConfig>) {
    setTuningDraft((prev) => ({ ...prev, ...patch }));
  }

  /** Reset a group of fields to their Headroom defaults. */
  function resetGroup(fields: Array<keyof HeadroomAdvancedConfig>) {
    setTuningDraft((prev) => {
      const next = { ...prev };
      const defaults = HEADROOM_ADVANCED_DEFAULTS as Record<string, unknown>;
      for (const field of fields) {
        (next as Record<string, unknown>)[field] = defaults[field];
      }
      return next;
    });
  }

  /** Parse a KEY=VALUE-per-line textarea into a record. */
  function parseEnvText(text: string): Record<string, string> {
    const record: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        record[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1);
      }
    }
    return record;
  }

  async function applyTuning() {
    if (!api) return;
    setTuningApplying(true);
    try {
      const merged: HeadroomAdvancedConfig = {
        ...tuningDraft,
        customEnv: parseEnvText(customEnvText),
        extraArgs: extraArgsText.trim() ? extraArgsText.trim().split(/\s+/) : [],
      };
      await api.headroom.setConfig({ advanced: merged });
      await refreshStatus();
    } finally {
      setTuningApplying(false);
    }
  }

  async function handleLlmlinguaToggle(enabled: boolean) {
    if (!api) return;
    if (enabled) {
      setLlmlinguaInstalling(true);
      setLlmlinguaMessage(null);
      try {
        const result = await api.headroom.installLlmlingua();
        if (!result.success) {
          setLlmlinguaMessage(result.message);
          return; // Don't toggle on if install failed.
        }
      } finally {
        setLlmlinguaInstalling(false);
      }
    }
    updateTuning("llmlingua", enabled);
  }

  async function setProviderMode(provider: string, mode: "off" | "middleware" | "proxy") {
    if (!api) return;
    const updated = { ...perProvider, [provider]: mode };
    // Remove "off" entries to keep the map sparse (they fall back to global mode)
    if (mode === "off") delete updated[provider];
    setPerProvider(updated);
    await api.headroom.setConfig({ perProvider: updated });
  }

  if (loading) {
    return <div className="text-muted p-4 text-sm">Loading...</div>;
  }

  const installed = status?.installed ?? false;
  const proxyRunning = status?.proxyRunning ?? false;
  const enabled = status?.enabled ?? false;
  const lastError = status?.lastError ?? null;
  const runtimeMethod = status?.runtimeMethod ?? "none";
  const currentMode = status?.mode ?? "off";

  // Effective advanced config for the live command preview + validation. Merges
  // the customEnv/extraArgs textareas so the preview reflects un-applied edits.
  // React Compiler memoizes these derived values.
  const previewAdvanced: HeadroomAdvancedConfig = {
    ...tuningDraft,
    customEnv: parseEnvText(customEnvText),
    extraArgs: extraArgsText.trim() ? extraArgsText.trim().split(/\s+/) : [],
  };
  const tuningErrors = validateTuning(previewAdvanced, customEnvText);
  const previewCommand = formatProxyCommand({
    telemetry: status?.telemetry ?? false,
    outputShaper: status?.outputShaper ?? false,
    memoryEnabled: status?.memoryEnabled ?? false,
    advanced: previewAdvanced,
  });

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div>
        <h3 className="text-foreground mb-2 text-sm font-medium">Headroom Compression</h3>
        <p className="text-muted mb-4 text-xs leading-relaxed">
          Headroom compresses tool outputs, logs, and conversation history before they reach the
          model — 60-95% fewer tokens with the same answers. Runs as a local Python proxy managed by
          Mux.
        </p>
        <a
          href="https://github.com/headroomlabs-ai/headroom"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2"
        >
          Learn more <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Enable Headroom</div>
          <div className="text-muted text-xs">
            Starts the proxy and applies compression to provider requests
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(c) => void toggleEnabled(c)}
          aria-label="Enable Headroom"
        />
      </div>

      {/* Status card */}
      <div className="bg-background-secondary border-border-medium space-y-2 rounded-lg border p-4">
        <div className="text-foreground text-sm font-medium">Status</div>
        <div className="text-muted grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <span>Installed:</span>
          <span className="text-foreground">{installed ? "Yes" : "No"}</span>
          <span>Proxy:</span>
          <span className="text-foreground">
            {proxyRunning ? `Running (${status?.port ?? "?"})` : "Stopped"}
          </span>
          <span>Runtime:</span>
          <span className="text-foreground">
            {runtimeMethod === "none" ? "Not found (uv or python3 required)" : runtimeMethod}
          </span>
          {status?.proxyBaseUrl && (
            <>
              <span>URL:</span>
              <span className="text-foreground truncate">{status.proxyBaseUrl}</span>
            </>
          )}
        </div>
        {lastError && <div className="mt-2 text-xs text-red-500">{lastError}</div>}
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => void handleProvision()}
            disabled={provisioning}
            variant="secondary"
            size="sm"
          >
            {provisioning ? "Installing..." : installed ? "Reinstall" : "Install"}
          </Button>
          <Button onClick={() => void doRestart(api, setStatus)} variant="secondary" size="sm">
            Restart Proxy
          </Button>
        </div>
      </div>

      {/* Tools & learning (only when installed) */}
      {installed && (
        <div className="bg-background-secondary border-border-medium space-y-3 rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">Tools &amp; Memory</div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void handleLearn(false)}
              disabled={learnLoading}
              variant="secondary"
              size="sm"
            >
              {learnLoading ? "Analyzing..." : "Preview Learn"}
            </Button>
            <Button
              onClick={() => void handleLearn(true)}
              disabled={learnLoading}
              variant="secondary"
              size="sm"
            >
              Apply Learn
            </Button>
            <Button
              onClick={() => void handleRegisterMcp()}
              disabled={mcpLoading}
              variant="secondary"
              size="sm"
            >
              {mcpLoading
                ? "Registering..."
                : mcpRegistered
                  ? "MCP Registered"
                  : "Register MCP Tools"}
            </Button>
          </div>
          {learnOutput && (
            <pre className="bg-background border-border-medium mt-2 max-h-40 overflow-auto rounded border p-2 text-xs whitespace-pre-wrap">
              {learnOutput}
            </pre>
          )}
        </div>
      )}

      {/* Compression mode */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Compression mode</div>
          <div className="text-muted text-xs">
            Middleware works with all providers. Proxy mode only supports Anthropic and OpenAI chat
            completions.
          </div>
        </div>
        <Select
          value={currentMode}
          onValueChange={(value) => void changeMode(value as "off" | "middleware" | "proxy")}
        >
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Stats */}
      {stats?.totalRequests != null && stats.totalRequests > 0 && (
        <div className="bg-background-secondary border-border-medium space-y-2 rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">Savings</div>
          <div className="text-muted grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <span>Requests:</span>
            <span className="text-foreground counter-nums">{stats.totalRequests}</span>
            {stats.tokensSaved != null && (
              <>
                <span>Tokens saved:</span>
                <span className="text-foreground counter-nums">
                  {stats.tokensSaved.toLocaleString()}
                </span>
              </>
            )}
            {stats.savingsPercent != null && (
              <>
                <span>Reduction:</span>
                <span className="text-foreground counter-nums">
                  {stats.savingsPercent.toFixed(1)}%
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Advanced settings */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Advanced</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">ML compression</div>
              <div className="text-muted text-xs">
                Install headroom-ai[ml] for Kompress text compression (adds ~hundreds of MB)
              </div>
            </div>
            <Switch
              checked={status?.includeMl ?? false}
              onCheckedChange={(v) => void toggleSubSetting("includeMl", v)}
              aria-label="ML compression"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Output token shaping</div>
              <div className="text-muted text-xs">
                Trim model verbosity (HEADROOM_OUTPUT_SHAPER)
              </div>
            </div>
            <Switch
              checked={status?.outputShaper ?? false}
              onCheckedChange={(v) => void toggleSubSetting("outputShaper", v)}
              aria-label="Output token shaping"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Anonymous telemetry</div>
              <div className="text-muted text-xs">
                Send anonymous usage data to Headroom (off by default)
              </div>
            </div>
            <Switch
              checked={status?.telemetry ?? false}
              onCheckedChange={(v) => void toggleSubSetting("telemetry", v)}
              aria-label="Telemetry"
            />
          </div>
        </div>
      </div>

      {/* Compression tuning (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setShowTuning((v) => !v)}
          className="text-foreground flex w-full items-center gap-1 text-sm font-medium"
        >
          <ChevronDown
            className={"h-4 w-4 transition-transform " + (showTuning ? "" : "-rotate-90")}
          />
          Compression tuning
        </button>
        {showTuning && (
          <div className="mt-4 space-y-5">
            {" "}
            {/* Presets — merge a named starting point into the draft (no auto-apply) */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted text-xs">Presets:</span>
              {HEADROOM_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  variant="secondary"
                  size="sm"
                  onClick={() => applyPreset(preset.patch)}
                  title={preset.description}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            {/* Live command preview — recomputed from the draft via the shared
                buildProxyCommand so it can never drift from what start() spawns */}
            <div>
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="text-muted hover:text-foreground text-xs underline underline-offset-2"
              >
                {showPreview ? "Hide" : "Show"} effective command
              </button>
              {showPreview && (
                <pre className="bg-background border-border-medium mt-2 max-h-32 overflow-auto rounded border p-2 font-mono text-xs break-all whitespace-pre-wrap">
                  {previewCommand}
                </pre>
              )}
            </div>
            {/* Context management */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-muted text-xs font-medium tracking-wide uppercase">
                  Context management
                </div>
                <button
                  type="button"
                  onClick={() =>
                    resetGroup(["intelligentContext", "intelligentScoring", "compressFirst"])
                  }
                  className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
                  aria-label="Reset Context management to defaults"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Intelligent context</div>
                  <div className="text-muted text-xs">
                    Multi-factor scoring (recency, similarity, errors). Disable to use oldest-first
                    RollingWindow.
                  </div>
                </div>
                <Switch
                  checked={tuningDraft.intelligentContext}
                  onCheckedChange={(v) => updateTuning("intelligentContext", v)}
                  aria-label="Intelligent context"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Importance scoring</div>
                  <div className="text-muted text-xs">
                    Multi-factor message scoring. Disable for faster, simpler drops.
                  </div>
                </div>
                <Switch
                  checked={tuningDraft.intelligentScoring}
                  onCheckedChange={(v) => updateTuning("intelligentScoring", v)}
                  aria-label="Importance scoring"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Compress before dropping</div>
                  <div className="text-muted text-xs">
                    Try deeper compression before dropping messages from context.
                  </div>
                </div>
                <Switch
                  checked={tuningDraft.compressFirst}
                  onCheckedChange={(v) => updateTuning("compressFirst", v)}
                  aria-label="Compress before dropping"
                />
              </div>
            </div>
            {/* Compression & cache */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-muted text-xs font-medium tracking-wide uppercase">
                  Compression &amp; cache
                </div>
                <button
                  type="button"
                  onClick={() => resetGroup(["optimize", "semanticCache"])}
                  className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
                  aria-label="Reset Compression & cache to defaults"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Optimization</div>
                  <div className="text-muted text-xs">
                    Apply compression transforms. Disable for passthrough (no changes).
                  </div>
                </div>
                <Switch
                  checked={tuningDraft.optimize}
                  onCheckedChange={(v) => updateTuning("optimize", v)}
                  aria-label="Optimization"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Semantic cache</div>
                  <div className="text-muted text-xs">
                    Cache similar queries to skip redundant processing.
                  </div>
                </div>
                <Switch
                  checked={tuningDraft.semanticCache}
                  onCheckedChange={(v) => updateTuning("semanticCache", v)}
                  aria-label="Semantic cache"
                />
              </div>
            </div>
            {/* LLMLingua */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-muted text-xs font-medium tracking-wide uppercase">
                  ML compression (LLMLingua)
                </div>
                <button
                  type="button"
                  onClick={() => resetGroup(["llmlingua", "llmlinguaDevice", "llmlinguaRate"])}
                  className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
                  aria-label="Reset ML compression (LLMLingua) to defaults"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
              <div className="bg-background-secondary border-border-medium rounded-lg border p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="text-foreground text-sm">Enable LLMLingua-2</div>
                    <div className="text-muted text-xs">
                      ML-based text compression for maximum savings.
                    </div>
                  </div>
                  <Switch
                    checked={tuningDraft.llmlingua}
                    onCheckedChange={(v) => void handleLlmlinguaToggle(v)}
                    disabled={llmlinguaInstalling}
                    aria-label="Enable LLMLingua"
                  />
                </div>
                <div className="text-muted mt-2 text-xs">
                  Adds ~2GB of dependencies (torch, transformers), 10-30s cold start, and ~1GB RAM.
                  Enable only when maximum compression justifies the cost.
                  {llmlinguaInstalling && " Installing..."}
                  {llmlinguaMessage && <span className="text-red-500"> {llmlinguaMessage}</span>}
                </div>
              </div>
              {tuningDraft.llmlingua && (
                <div className="space-y-2">
                  <label className="text-foreground flex items-center justify-between gap-4 text-sm">
                    Device
                    <Select
                      value={tuningDraft.llmlinguaDevice}
                      onValueChange={(v) =>
                        updateTuning("llmlinguaDevice", v as "auto" | "cuda" | "cpu" | "mps")
                      }
                    >
                      <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-[120px] cursor-pointer rounded-md border px-3 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">auto</SelectItem>
                        <SelectItem value="cuda">cuda</SelectItem>
                        <SelectItem value="cpu">cpu</SelectItem>
                        <SelectItem value="mps">mps</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-foreground flex items-center justify-between gap-4 text-sm">
                    Keep rate
                    <span className="text-muted counter-nums text-xs">
                      {Math.round(tuningDraft.llmlinguaRate * 100)}%
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={tuningDraft.llmlinguaRate}
                    onChange={(e) => updateTuning("llmlinguaRate", parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}
            </div>
            {/* Cost & output */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-muted text-xs font-medium tracking-wide uppercase">
                  Cost &amp; output
                </div>
                <button
                  type="button"
                  onClick={() => resetGroup(["budgetUsd", "outputHoldout"])}
                  className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
                  aria-label="Reset Cost & output to defaults"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
              <label className="text-foreground flex items-center justify-between gap-4 text-sm">
                Daily budget (USD)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={tuningDraft.budgetUsd ?? ""}
                  placeholder="No cap"
                  onChange={(e) =>
                    updateTuning(
                      "budgetUsd",
                      e.target.value === "" ? null : parseFloat(e.target.value)
                    )
                  }
                  className="border-border-medium bg-background-secondary text-foreground h-8 w-[100px] rounded-md border px-2 text-sm"
                />
              </label>
              <div>
                <label className="text-foreground mb-1 flex items-center justify-between gap-4 text-sm">
                  Output holdout (control group)
                  <span className="text-muted counter-nums text-xs">
                    {Math.round(tuningDraft.outputHoldout * 100)}%
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.05}
                  value={tuningDraft.outputHoldout}
                  onChange={(e) => updateTuning("outputHoldout", parseFloat(e.target.value))}
                  className="w-full"
                />
                <div className="text-muted mt-1 text-xs">
                  Fraction of conversations left unshaped to measure real output savings.
                </div>
              </div>
            </div>
            {/* Diagnostics */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-muted text-xs font-medium tracking-wide uppercase">
                  Diagnostics
                </div>
                <button
                  type="button"
                  onClick={() => resetGroup(["contextTool", "logLevel"])}
                  className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
                  aria-label="Reset Diagnostics to defaults"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
              <label className="text-foreground flex items-center justify-between gap-4 text-sm">
                Context tool
                <Select
                  value={tuningDraft.contextTool}
                  onValueChange={(v) => updateTuning("contextTool", v as "rtk" | "lean-ctx")}
                >
                  <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-[120px] cursor-pointer rounded-md border px-3 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rtk">rtk</SelectItem>
                    <SelectItem value="lean-ctx">lean-ctx</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="text-foreground flex items-center justify-between gap-4 text-sm">
                Log level
                <Select
                  value={tuningDraft.logLevel}
                  onValueChange={(v) =>
                    updateTuning("logLevel", v as "DEBUG" | "INFO" | "WARNING" | "ERROR")
                  }
                >
                  <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-[120px] cursor-pointer rounded-md border px-3 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEBUG">DEBUG</SelectItem>
                    <SelectItem value="INFO">INFO</SelectItem>
                    <SelectItem value="WARNING">WARNING</SelectItem>
                    <SelectItem value="ERROR">ERROR</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            {/* Power-user overrides */}
            <div className="space-y-3">
              <div className="text-muted text-xs font-medium tracking-wide uppercase">
                Power-user overrides
              </div>
              <div>
                <label className="text-foreground mb-1 block text-sm">
                  Custom env vars (KEY=VALUE per line)
                </label>
                <textarea
                  value={customEnvText}
                  onChange={(e) => setCustomEnvText(e.target.value)}
                  rows={3}
                  placeholder={
                    "HEADROOM_SAVINGS_PATH=/custom/path\nOPENAI_TARGET_API_URL=https://..."
                  }
                  className="border-border-medium bg-background-secondary text-foreground w-full rounded-md border p-2 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-foreground mb-1 block text-sm">
                  Extra CLI args (whitespace-separated)
                </label>
                <input
                  type="text"
                  value={extraArgsText}
                  onChange={(e) => setExtraArgsText(e.target.value)}
                  placeholder="--log-file /tmp/headroom.jsonl"
                  className="border-border-medium bg-background-secondary text-foreground w-full rounded-md border px-2 py-1 font-mono text-xs"
                />
              </div>
            </div>
            {/* Info note */}
            <p className="text-muted text-xs leading-relaxed">
              Per-algorithm weights (SmartCrusher, CacheAligner, scoring) are library-only and
              cannot be set through the proxy. The toggles above expose everything the proxy
              supports. Use the overrides box for anything else.
            </p>
            {/* Validation + Apply */}
            {tuningErrors.length > 0 && (
              <div className="text-xs text-red-500">
                {tuningErrors.map((err) => (
                  <div key={err}>{err}</div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() => void applyTuning()}
                disabled={tuningApplying || tuningErrors.length > 0}
                size="sm"
              >
                {tuningApplying ? "Applying..." : "Apply & restart"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Per-provider overrides */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Per-provider mode</h3>
        <p className="text-muted mb-4 text-xs leading-relaxed">
          Override the global mode for individual providers. &ldquo;Off&rdquo; falls back to the
          global default. Proxy mode only works for Anthropic and OpenAI-compatible providers.
        </p>
        <div className="space-y-2">
          {SUPPORTED_PROVIDERS.map((provider) => (
            <div key={provider} className="flex items-center justify-between gap-4">
              <div className="text-foreground min-w-0 flex-1 truncate text-sm">
                {PROVIDER_DISPLAY_NAMES[provider] ?? provider}
              </div>
              <Select
                value={perProvider[provider] ?? "off"}
                onValueChange={(value) =>
                  void setProviderMode(provider, value as "off" | "middleware" | "proxy")
                }
              >
                <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-[180px] cursor-pointer rounded-md border px-3 text-xs transition-colors">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      {/* Per-workspace overrides — overview + inline editor. Surfaces workspaces
          that diverge from the global routing so Settings stays the single source
          of truth across all workspaces. */}
      <div>
        <h3 className="text-foreground mb-2 text-sm font-medium">Per-workspace overrides</h3>
        <p className="text-muted mb-4 text-xs leading-relaxed">
          Workspaces below override the global Headroom routing (enabled / mode / per-provider).
          Click one to edit it inline.
        </p>
        {workspaceOverrides.length === 0 ? (
          <p className="text-muted text-xs">No workspaces currently override the global config.</p>
        ) : (
          <div className="space-y-2">
            {workspaceOverrides.map((entry) => (
              <div
                key={entry.workspaceId}
                className="bg-background-secondary border-border-medium rounded-lg border p-3"
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpandedWorkspace(
                      expandedWorkspace === entry.workspaceId ? null : entry.workspaceId
                    )
                  }
                  className="text-foreground flex w-full items-center justify-between gap-4 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {entry.title ?? entry.workspaceId}
                  </span>
                  <ChevronDown
                    className={
                      "h-4 w-4 shrink-0 transition-transform " +
                      (expandedWorkspace === entry.workspaceId ? "" : "-rotate-90")
                    }
                  />
                </button>
                {expandedWorkspace === entry.workspaceId && (
                  <div className="border-border-medium mt-3 border-t pt-3">
                    <HeadroomWorkspaceEditor workspaceId={entry.workspaceId} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
