/**
 * Headroom Section — Settings UI for the Headroom context-compression integration.
 *
 * Shows provisioning status, proxy health, token-savings stats, and the global
 * routing mode toggle. Config changes trigger a proxy restart via the backend.
 */

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
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

interface HeadroomStatus {
  enabled: boolean;
  installed: boolean;
  provisioning: string;
  proxyRunning: boolean;
  proxyBaseUrl: string | null;
  port: number | null;
  runtimeMethod: string;
  lastError: string | null;
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

  async function refreshStatus() {
    if (!api) return;
    try {
      const s = await api.headroom.getStatus();
      setStatus(s);
      const st = await api.headroom.getStats();
      setStats(st);
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

  if (loading) {
    return <div className="text-muted p-4 text-sm">Loading...</div>;
  }

  const installed = status?.installed ?? false;
  const proxyRunning = status?.proxyRunning ?? false;
  const enabled = status?.enabled ?? false;
  const lastError = status?.lastError ?? null;
  const runtimeMethod = status?.runtimeMethod ?? "none";
  const currentMode = enabled ? "middleware" : "off";

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
              checked={false}
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
              checked={false}
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
              checked={false}
              onCheckedChange={(v) => void toggleSubSetting("telemetry", v)}
              aria-label="Telemetry"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
