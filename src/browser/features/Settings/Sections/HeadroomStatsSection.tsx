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
import { Loader2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";

type HeadroomStatus = Awaited<ReturnType<APIClient["headroom"]["getStatus"]>>;
type HeadroomStats = Awaited<ReturnType<APIClient["headroom"]["getStats"]>>;

function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-3">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-foreground counter-nums mt-1 text-base font-medium">
        {value ?? "—"}
      </dd>
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
  // Stats only become meaningful once the proxy has compressed traffic.
  const hasData =
    stats?.totalRequests != null && stats.totalRequests > 0;

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

      {!proxyRunning ? (
        <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">Proxy not running</div>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            Stats appear once the Headroom proxy is running and compressing traffic.
          </p>
        </div>
      ) : !hasData ? (
        <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
          <div className="text-foreground text-sm font-medium">No compression stats yet</div>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            The proxy is running but hasn&apos;t compressed any requests. Stats will populate as
            traffic flows through it.
          </p>
        </div>
      ) : (
        <>
          <div>
            <div className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">
              Session
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:grid-cols-3">
              <StatTile
                label="Requests"
                value={
                  stats?.totalRequests != null ? String(stats.totalRequests) : null
                }
              />
              <StatTile
                label="Tokens saved"
                value={
                  stats?.tokensSaved != null
                    ? stats.tokensSaved.toLocaleString()
                    : null
                }
              />
              <StatTile
                label="Reduction"
                value={
                  stats?.savingsPercent != null
                    ? stats.savingsPercent.toFixed(1) + "%"
                    : null
                }
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
                value={
                  stats?.persistentRequests != null
                    ? String(stats.persistentRequests)
                    : null
                }
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
      )}
    </div>
  );
}
