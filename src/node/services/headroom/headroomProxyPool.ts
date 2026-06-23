import type { HeadroomConfig } from "@/common/config/schemas/headroom";
import { log } from "@/node/services/log";
import { headroomProcessKey } from "./headroomConfigResolver";
import { HeadroomProxyProcess } from "./headroomProxyProcess";

/** Context the pool needs to spawn a proxy process (resolved lazily at spawn time). */
export interface PoolLaunchContext {
  headroomPath: string;
  openaiTargetUrl?: string;
  anthropicBaseUrl?: string;
}

/** Provider of the launch context; returns null when headroom isn't installed yet. */
export type PoolLaunchContextProvider = () => PoolLaunchContext | null;

interface PoolEntry {
  process: HeadroomProxyProcess;
  baseUrl: string | null;
  /** Last time this entry served a request (idle-eviction + LRU cap use it). */
  lastUsedAt: number;
  /** In-flight start() promise — single-flight so concurrent callers share one spawn. */
  startPromise: Promise<void> | null;
}

/** Max concurrent proxy processes. Each is a full Python process; LLMLingua ones
 *  cost ~1GB RAM, so this bounds total resource use. */
const DEFAULT_MAX_POOL_SIZE = 4;
/** Idle processes are stopped after this long with no traffic. Warmth through bursts
 *  is desirable (LLMLingua cold-starts ~30s), but unbounded liveness wastes RAM. */
const DEFAULT_IDLE_EVICT_MS = 5 * 60_000;
/** How often the idle sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;

/** Provider of a fresh proxy process; defaults to the real one. Injectable for tests. */
export type ProxyProcessFactory = () => HeadroomProxyProcess;

/**
 * A pool of headroom proxy processes, keyed by the deterministic process-config
 * digest (headroomProcessKey). The global-default config is just one member; a
 * workspace whose effective process config differs gets its own process.
 *
 * Lifecycle model (idle-eviction, no refcounting): getOrStart() get-or-creates the
 * entry for a config, touches lastUsedAt, returns the cached baseUrl (null until the
 * process is healthy). The first call for a NEW config kicks off a background spawn
 * and returns null (the request fails open — it is not blocked). A subsequent call
 * finds the process running. This avoids the release-lifecycle races that refcounting
 * would introduce (evicting a process mid /v1/compress call).
 *
 * HeadroomProxyProcess itself (spawn / health-check / stop / crash detection) is left
 * UNCHANGED — the pool only adds map management + eviction on top.
 */
export class HeadroomProxyPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly createProcess: ProxyProcessFactory;

  constructor(
    private readonly resolveContext: PoolLaunchContextProvider,
    private readonly maxPoolSize = DEFAULT_MAX_POOL_SIZE,
    private readonly idleEvictMs = DEFAULT_IDLE_EVICT_MS,
    createProcess: ProxyProcessFactory = () => new HeadroomProxyProcess()
  ) {
    this.createProcess = createProcess;
    // unref so the sweep never keeps the event loop alive on quit.
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Number of live proxy processes. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Get the cached baseUrl for this config's process, or null if it isn't healthy
   * yet. Lazily starts the process on first sight of a new config (background). This
   * is the only call the request path makes — it is synchronous and fail-open.
   */
  getOrStart(effective: HeadroomConfig): string | null {
    const key = headroomProcessKey(effective);
    const entry = this.getOrCreate(key);
    entry.lastUsedAt = Date.now();
    if (entry.baseUrl) return entry.baseUrl;
    if (!entry.startPromise) this.kickoffStart(entry, effective);
    return null;
  }

  /** Info for a config's process (for status reporting), or null if absent. */
  getInfo(effective: HeadroomConfig) {
    return this.entries.get(headroomProcessKey(effective))?.process.info ?? null;
  }

  /**
   * Eagerly start (and await) the process for a config. Used by service.start() /
   * restart() to pre-warm the global entry so the very first request is served.
   */
  async startEntry(effective: HeadroomConfig): Promise<void> {
    const key = headroomProcessKey(effective);
    const entry = this.getOrCreate(key);
    entry.lastUsedAt = Date.now();
    if (entry.baseUrl) return;
    if (!entry.startPromise) this.kickoffStart(entry, effective);
    if (entry.startPromise) await entry.startPromise;
  }

  /** Stop + remove the process for a config (e.g. after its config changed). */
  async stopEntry(effective: HeadroomConfig): Promise<void> {
    const key = headroomProcessKey(effective);
    const entry = this.entries.get(key);
    if (!entry) return;
    await entry.process.stop();
    this.entries.delete(key);
  }

  /** Restart the process for a config: stop, then start + await. */
  async restartEntry(effective: HeadroomConfig): Promise<void> {
    await this.stopEntry(effective);
    await this.startEntry(effective);
  }

  /** Stop every process and clear the pool (shutdown / full config reset). */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.entries.values()).map((e) =>
      e.process.stop().catch(() => undefined)
    );
    this.entries.clear();
    await Promise.all(stops);
  }

  /** Release the sweep timer. */
  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private getOrCreate(key: string): PoolEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      this.enforceCap();
      entry = {
        process: this.createProcess(),
        baseUrl: null,
        lastUsedAt: Date.now(),
        startPromise: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Kick off a single-flight background start for an entry. */
  private kickoffStart(entry: PoolEntry, effective: HeadroomConfig): void {
    const ctx = this.resolveContext();
    if (!ctx) return; // headroom not installed yet; a later call retries.
    entry.startPromise = (async () => {
      try {
        const info = await entry.process.start({
          headroomPath: ctx.headroomPath,
          telemetry: effective.telemetry,
          outputShaper: effective.outputShaper,
          memoryEnabled: effective.memory.enabled,
          advanced: effective.advanced,
          openaiTargetUrl: ctx.openaiTargetUrl,
          anthropicBaseUrl: ctx.anthropicBaseUrl,
          onUnexpectedExit: () => {
            // Lazy respawn: clear state so the next getOrStart re-spawns.
            entry.baseUrl = null;
            entry.startPromise = null;
            log.warn("[headroom] pooled proxy exited unexpectedly; will respawn on next request");
          },
        });
        entry.baseUrl = info.baseUrl;
      } catch (err) {
        log.warn("[headroom] pooled proxy start failed", { error: String(err) });
      } finally {
        entry.startPromise = null;
      }
    })();
  }

  /** Drop idle entries past the TTL. Keeps at least one (the most-recently-used). */
  private sweepIdle(): void {
    if (this.entries.size <= 1) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.idleEvictMs) {
        void entry.process.stop().catch(() => undefined);
        this.entries.delete(key);
      }
    }
  }

  /** Make room for a new entry by evicting the least-recently-used one. */
  private enforceCap(): void {
    if (this.entries.size < this.maxPoolSize) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.entries.get(oldestKey);
      if (entry) void entry.process.stop().catch(() => undefined);
      this.entries.delete(oldestKey);
    }
  }
}
