/**
 * Headroom Stats Section — dedicated settings section for Headroom compression
 * statistics (request volume, tokens saved, reduction %, and persistent totals).
 *
 * Surfaced as its own settings entry, gated on Headroom being enabled in
 * SettingsPage. Stats previously lived inline in HeadroomSection; they were moved
 * here so the config panel focuses on provisioning/tuning while this section is
 * the single home for usage telemetry.
 *
 * The section fetches its own status + stats and polls stats every 10s while the
 * proxy is running. Stats come from the running proxy, so the section surfaces
 * distinct states for "not running" and "running but no traffic yet".
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";

type HeadroomStatus = Awaited<ReturnType<APIClient["headroom"]["getStatus"]>>;
type HeadroomStats = Awaited<ReturnType<APIClient["headroom"]["getStats"]>>;

function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-3">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-foreground counter-nums mt-1 text-base font-medium">{value ?? "—"}</dd>
    </div>
  );
}

export function HeadroomStatsSection() {
  const { api } = useAPI();
  const [status, setStatus] = useState<HeadroomStatus | null>(null);
  const [stats, setStats] = useState<HeadroomStats | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!api) return;
    try {
      const s = await api.headroom.getStatus();
      setStatus(s);
      setStats(await api.headroom.getStats());
    } catch {
      // Non-fatal — keep showing the last-known state.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!api) return;
    void refresh();
    // Refresh stats every 10s while the proxy is running.
    const interval = setInterval(() => {
      if (status?.proxyRunning) {
        void refresh();
      }
    }, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status?.proxyRunning]);

  if (loading) {
    return (
      <div className="text-muted p-4 text-sm">
        <Loader2 className="inline-block h-3.5 w-3.5 animate-spin align-text-bottom" /> Loading
        stats…
      </div>
    );
  }

  const proxyRunning = status?.proxyRunning ?? false;

  // Compression is happening if the proxy reports compressed requests, or (as a
  // fallback when that field is absent) if it has saved any tokens.
  const requestsCompressed = stats?.requestsCompressed ?? null;
  const tokensSaved = stats?.tokensSaved ?? null;
  const isCompressing =
    requestsCompressed != null ? requestsCompressed > 0 : tokensSaved != null && tokensSaved > 0;

  // Traffic signal: route_counts are populated only for real compression-eligible
  // messages (excludes our own /health + /stats polling), so their sum is the
  // precise "has the proxy examined real traffic" indicator.
  const routeCounts = stats?.routeCounts ?? null;
  const messagesSeen = routeCounts
    ? Object.values(routeCounts).reduce((sum, n) => sum + (n ?? 0), 0)
    : 0;
  const trafficSeen = messagesSeen > 0;

  // The final render branch below is the no-op case: attached + real traffic
  // flowed, but nothing compressed. This is exactly the "headroom isn't doing
  // anything" failure mode — almost always caused by a too-conservative policy
  // (protected system/user messages, high token floor) that a Savings profile fixes.

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div>
        <h3 className="text-foreground mb-2 text-sm font-medium">Headroom Stats</h3>
        <p className="text-muted text-xs leading-relaxed">
          Live compression totals from the Headroom proxy. Session figures reset when the proxy
          restarts; persistent totals accumulate across restarts.
        </p>
      </div>

      {/* Order matters: a compressing proxy shows data even before route_counts
          populate; the no-op warning only fires when real traffic was examined
          (route_counts > 0) yet nothing was compressed. */}
      {!proxyRunning ? (
        <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">Proxy not running</div>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            Stats appear once the Headroom proxy is running and compressing traffic.
          </p>
        </div>
      ) : isCompressing ? (
        <>
          <div>
            <div className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">
              Session
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:grid-cols-3">
              <StatTile
                label="Requests"
                value={stats?.totalRequests != null ? String(stats.totalRequests) : null}
              />
              <StatTile
                label="Tokens saved"
                value={stats?.tokensSaved != null ? stats.tokensSaved.toLocaleString() : null}
              />
              <StatTile
                label="Reduction"
                value={stats?.savingsPercent != null ? stats.savingsPercent.toFixed(1) + "%" : null}
              />
            </dl>
          </div>
          <div>
            <div className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">
              Persistent
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:grid-cols-3">
              <StatTile
                label="Requests"
                value={stats?.persistentRequests != null ? String(stats.persistentRequests) : null}
              />
              <StatTile
                label="Tokens saved"
                value={
                  stats?.persistentTokensSaved != null
                    ? stats.persistentTokensSaved.toLocaleString()
                    : null
                }
              />
            </dl>
          </div>
        </>
      ) : !trafficSeen ? (
        <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">No compression stats yet</div>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            The proxy is running but hasn&apos;t seen any traffic. Stats will populate as requests
            flow through it.
          </p>
        </div>
      ) : (
        <div className="border-warning bg-warning/10 flex gap-2 rounded-lg border p-4">
          <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div className="text-foreground text-sm font-medium">
              Headroom is attached but hasn&apos;t compressed anything
            </div>
            <p className="text-muted text-xs leading-relaxed">
              The proxy has examined{" "}
              <span className="text-foreground counter-nums">{messagesSeen.toLocaleString()}</span>{" "}
              messages but compressed none of them. The routing policy is protecting or skipping
              everything — usually because system/user messages are protected and the token floor is
              high. Pick a <span className="text-foreground">Savings Profile</span> in Headroom
              settings to engage compression.
            </p>
            {routeCounts && (
              <p className="text-muted text-xs leading-relaxed">
                Breakdown: {formatRouteCounts(routeCounts)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Render the proxy's route_counts breakdown as a compact human string. */
function formatRouteCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  const protectedCount = (counts.user_msg ?? 0) + (counts.system_msg ?? 0);
  if (protectedCount > 0) parts.push(`${protectedCount.toLocaleString()} protected`);
  if ((counts.small ?? 0) > 0) parts.push(`${counts.small.toLocaleString()} too small`);
  if ((counts.non_string ?? 0) > 0) parts.push(`${counts.non_string.toLocaleString()} non-text`);
  if ((counts.ratio_too_high ?? 0) > 0)
    parts.push(`${counts.ratio_too_high.toLocaleString()} ratio-capped`);
  if ((counts.cache_hit ?? 0) > 0) parts.push(`${counts.cache_hit.toLocaleString()} cached`);
  return parts.join(" · ") || "no breakdown";
}
