/**
 * Per-workspace Headroom editor.
 *
 * Shows the EFFECTIVE routing for a workspace (global ⊕ sparse override) with
 * "inherited" badges for fields the workspace leaves to global, and lets the user
 * override enabled / mode / per-provider routing. Writes go through
 * api.headroom.setWorkspaceHeadroom (sparse: all-null clears the whole override).
 *
 * Self-contained — takes a workspaceId and renders its own controls, so it can be
 * hosted in any workspace settings surface. The global Settings page hosts an
 * overview list of workspaces that have overrides (see HeadroomSection).
 */

import { useEffect, useState } from "react";
import type { HeadroomWorkspaceOverride } from "@/common/config/schemas/headroom";
import { Switch } from "@/browser/components/Switch/Switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";

const ALL_NULL: HeadroomWorkspaceOverride = {
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
};

const MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "middleware", label: "Middleware (all providers)" },
  { value: "proxy", label: "Proxy (Anthropic + OpenAI chat)" },
];

interface EffectiveRouting {
  enabled: boolean;
  mode: "off" | "middleware" | "proxy";
  perProvider: Record<string, "off" | "middleware" | "proxy">;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-background-secondary border-border-medium ml-2 rounded border px-1 py-0.5 text-[10px] tracking-wide uppercase">
      {children}
    </span>
  );
}

export interface HeadroomWorkspaceEditorProps {
  workspaceId: string;
}

export function HeadroomWorkspaceEditor(props: HeadroomWorkspaceEditorProps) {
  const { api } = useAPI();
  const [override, setOverride] = useState<HeadroomWorkspaceOverride | null>(null);
  const [effective, setEffective] = useState<EffectiveRouting | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!api) return;
    try {
      const r = await api.headroom.getWorkspaceHeadroom({ workspaceId: props.workspaceId });
      setOverride(r.override);
      setEffective(r.effective);
    } catch {
      // Non-fatal — show stale.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.workspaceId]);

  if (loading || !effective) {
    return <div className="text-muted p-2 text-sm">Loading...</div>;
  }

  const hasOverride = override != null;
  const enabledOverridden = override?.enabled != null;
  const modeOverridden = override?.mode != null;

  async function patch(p: Partial<HeadroomWorkspaceOverride>) {
    if (!api) return;
    const next: HeadroomWorkspaceOverride = { ...(override ?? ALL_NULL), ...p };
    setOverride(next);
    await api.headroom.setWorkspaceHeadroom({ workspaceId: props.workspaceId, override: next });
  }

  async function setProviderMode(provider: string, mode: "off" | "middleware" | "proxy") {
    const current = override?.perProvider ?? {};
    const updated = { ...current };
    if (mode === "off") delete updated[provider];
    else updated[provider] = mode;
    await patch({ perProvider: Object.keys(updated).length ? updated : null });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">
            Enable Headroom
            {!enabledOverridden && <Badge>Inherited</Badge>}
          </div>
          <div className="text-muted text-xs">Toggle compression for this workspace.</div>
        </div>
        <Switch
          checked={effective.enabled}
          onCheckedChange={(c) => void patch({ enabled: c })}
          aria-label="Enable Headroom for this workspace"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">
            Compression mode
            {!modeOverridden && <Badge>Inherited</Badge>}
          </div>
          <div className="text-muted text-xs">Middleware works everywhere; proxy is limited.</div>
        </div>
        <Select
          value={effective.mode}
          onValueChange={(value) => void patch({ mode: value as "off" | "middleware" | "proxy" })}
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

      <div>
        <div className="text-foreground mb-2 text-sm">
          Per-provider mode
          {override?.perProvider == null && <Badge>Inherited</Badge>}
        </div>
        <div className="space-y-2">
          {SUPPORTED_PROVIDERS.map((provider) => (
            <div key={provider} className="flex items-center justify-between gap-4">
              <div className="text-foreground min-w-0 flex-1 truncate text-sm">
                {PROVIDER_DISPLAY_NAMES[provider] ?? provider}
              </div>
              <Select
                value={override?.perProvider?.[provider] ?? "off"}
                onValueChange={(value) =>
                  void setProviderMode(provider, value as "off" | "middleware" | "proxy")
                }
              >
                <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-[160px] cursor-pointer rounded-md border px-3 text-xs transition-colors">
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

      {hasOverride && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void (async () => {
                if (!api) return;
                await api.headroom.clearWorkspaceHeadroom({
                  workspaceId: props.workspaceId,
                });
                setOverride(null);
              })()
            }
          >
            Reset to global
          </Button>
        </div>
      )}
    </div>
  );
}
