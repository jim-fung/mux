/**
 * HeadroomService — orchestrator for the Headroom integration.
 *
 * Owns the lifecycle of the headroom proxy: provisioning (venv + pip install),
 * process supervision (spawn + health-check + teardown), and exposes status/stats
 * to the UI via oRPC. The ProviderModelFactory reads `getProxyBaseUrl()` to know
 * where the proxy is (or null if not running) so it can attach the compress middleware.
 *
 * Lifecycle hooks: constructed in ServiceContainer (like DevToolsService), started in
 * ServiceContainer.initialize(), stopped in ServiceContainer.dispose(). All operations
 * are wrapped in try/catch so startup failures never crash the app (AGENTS.md: startup
 * must never crash).
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Config } from "@/node/config";
import type {
  HeadroomConfig,
  HeadroomAdvancedConfig,
  HeadroomWorkspaceOverride,
} from "@/common/config/schemas/headroom";
import { HEADROOM_ADVANCED_DEFAULTS, HeadroomConfigSchema } from "@/common/config/schemas/headroom";
import { resolveHeadroomConfig } from "./headroomConfigResolver";
import { log } from "@/node/services/log";
import { shellQuote } from "@/common/utils/shell";
import {
  getHeadroomBinary,
  getHeadroomVenvPath,
  installHeadroomExtra,
  isHeadroomInstalled,
  provisionHeadroom,
  resolveProvisioningMethod,
  type HeadroomRuntimeMethod,
} from "./headroomProvisioner";
import { HeadroomProxyPool, type PoolLaunchContext } from "./headroomProxyPool";
import { HeadroomClient } from "./headroomClient";

export type HeadroomProvisioningState = "not-installed" | "provisioning" | "installed" | "failed";

export interface HeadroomStatus {
  enabled: boolean;
  installed: boolean;
  provisioning: HeadroomProvisioningState;
  proxyRunning: boolean;
  proxyBaseUrl: string | null;
  port: number | null;
  /** Description of the provisioning method available, for UI display. */
  runtimeMethod: HeadroomRuntimeMethod;
  lastError: string | null;
  /** Live config values for UI toggle binding (not hardcoded). */
  mode: string;
  autoProvision: boolean;
  includeMl: boolean;
  outputShaper: boolean;
  telemetry: boolean;
  memoryEnabled: boolean;
  perProvider: Record<string, string>;
  /** Fine-grained proxy knobs from the Advanced settings panel. */
  advanced: HeadroomAdvancedConfig;
}

export class HeadroomService extends EventEmitter {
  /**
   * Pool of headroom proxy processes, keyed by process-config digest. The global
   * default is one member; a workspace whose effective process config differs gets
   * its own process. Idle-eviction + a size cap bound total RAM. Replaces the old
   * single-process field — HeadroomProxyProcess itself is unchanged.
   */
  private readonly pool: HeadroomProxyPool;
  private provisioningState: HeadroomProvisioningState = "not-installed";
  private lastError: string | null = null;
  private started = false;
  /** Single-flight guard: concurrent restart() calls share one in-flight run. */
  private restartInFlight: Promise<HeadroomStatus> | null = null;
  /** Single-flight guard: concurrent provision() calls share one in-flight run. */
  private provisionInFlight: Promise<HeadroomStatus> | null = null;

  constructor(private readonly config: Config) {
    super();
    // The pool resolves the spawn context lazily, so it only needs headroom
    // installed when a process is actually about to start.
    this.pool = new HeadroomProxyPool(() => this.resolveLaunchContext());
  }

  /** Read the current headroom config (live, from disk). */
  getConfig(): HeadroomConfig {
    const onDisk = this.config.loadConfigOrDefault();
    const raw = onDisk.headroom;
    if (!raw) {
      return {
        enabled: false,
        autoProvision: true,
        mode: "off",
        perProvider: {},
        includeMl: false,
        proxyBaseUrl: null,
        telemetry: false,
        outputShaper: false,
        memory: { enabled: false },
        advanced: HEADROOM_ADVANCED_DEFAULTS,
      };
    }
    // Apply schema defaults so a partial on-disk block (e.g. only {enabled, mode})
    // is filled with HeadroomConfigSchema's documented defaults rather than
    // surfacing undefined sub-objects to status/start.
    return HeadroomConfigSchema.parse(raw);
  }
  /** Enumerate workspaces that have a Headroom override (sparse map, for the
   *  Settings overview). Title is best-effort from workspace metadata. */
  listWorkspaceOverrides(): Array<{
    workspaceId: string;
    title: string | null;
    override: HeadroomWorkspaceOverride;
  }> {
    const config = this.config.loadConfigOrDefault();
    const out: Array<{
      workspaceId: string;
      title: string | null;
      override: HeadroomWorkspaceOverride;
    }> = [];
    for (const projectConfig of config.projects.values()) {
      for (const ws of projectConfig.workspaces) {
        if (ws.headroom && ws.id) {
          out.push({
            workspaceId: ws.id,
            title: ws.title ?? ws.name ?? null,
            override: ws.headroom,
          });
        }
      }
    }
    return out;
  }

  /** Read the raw per-workspace override, or null when the workspace has none. */
  getWorkspaceOverride(workspaceId: string): HeadroomWorkspaceOverride | null {
    const found = this.config.findWorkspace(workspaceId);
    if (!found) return null;
    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(found.projectPath);
    const workspaceEntry =
      projectConfig?.workspaces.find((ws) => ws.id === workspaceId) ??
      projectConfig?.workspaces.find((ws) => ws.path === found.workspacePath);
    return workspaceEntry?.headroom ?? null;
  }

  /**
   * Resolve the effective HeadroomConfig for a workspace by layering its sparse
   * override on the global config. The ProviderModelFactory calls this per
   * model-build so routing (enabled / mode / perProvider) can differ per workspace
   * on the shared global proxy. `workspaceId == null` returns the global config.
   */
  getEffectiveConfig(workspaceId: string | null): HeadroomConfig {
    const global = this.getConfig();
    if (!workspaceId) return global;
    return resolveHeadroomConfig(global, this.getWorkspaceOverride(workspaceId));
  }

  /** Write the per-workspace override. All-null drops the record (mirrors the
   *  goalDefaults sparse pattern so "no override" is the canonical state). */
  async setWorkspaceOverride(
    workspaceId: string,
    override: HeadroomWorkspaceOverride
  ): Promise<void> {
    const found = this.config.findWorkspace(workspaceId);
    if (!found) return;
    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(found.projectPath);
    const workspaceEntry =
      projectConfig?.workspaces.find((ws) => ws.id === workspaceId) ??
      projectConfig?.workspaces.find((ws) => ws.path === found.workspacePath);
    if (!workspaceEntry) return;

    const allNull = Object.values(override).every((v) => v == null);
    if (allNull) {
      if (workspaceEntry.headroom == null) return;
      delete workspaceEntry.headroom;
    } else {
      workspaceEntry.headroom = {
        enabled: override.enabled ?? null,
        mode: override.mode ?? null,
        perProvider: override.perProvider ?? null,
        outputShaper: override.outputShaper ?? null,
        telemetry: override.telemetry ?? null,
        memoryEnabled: override.memoryEnabled ?? null,
        includeMl: override.includeMl ?? null,
        advanced: override.advanced ?? null,
      };
    }
    await this.config.saveConfig(config);
  }

  /** Remove the per-workspace override entirely (resolves back to global). */
  async clearWorkspaceOverride(workspaceId: string): Promise<void> {
    await this.setWorkspaceOverride(workspaceId, {
      enabled: null,
      mode: null,
      perProvider: null,
      outputShaper: null,
      telemetry: null,
      memoryEnabled: null,
      includeMl: null,
      advanced: null,
    });
  }

  /**
   * Start the service: provision if needed, then launch the proxy.
   * Called from ServiceContainer.initialize(). Never throws.
   */
  async start(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      log.debug("[headroom] start() called but integration disabled — skipping");
      return;
    }

    this.started = true;

    // If the user configured an external proxyBaseUrl, we don't manage processes.
    if (cfg.proxyBaseUrl) {
      log.info("[headroom] using external proxy", { baseUrl: cfg.proxyBaseUrl });
      return;
    }

    // Pre-warm the global-default pool entry so the very first request is served.
    // Per-workspace entries start lazily on first use (getOrStart).
    try {
      await this.ensureInstalled(cfg.includeMl);
      await this.pool.startEntry(cfg);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn("[headroom] failed to start proxy (chat will continue uncompressed)", {
        error: this.lastError,
      });
      // Don't throw — fail-open at the service level too.
    }
  }

  /** Stop all proxy processes. Called from ServiceContainer.dispose(). */
  async stop(): Promise<void> {
    this.started = false;
    this.pool.dispose();
    await this.pool.stopAll();
  }

  /** Ensure headroom is installed (provision if autoProvision is on). */
  private async ensureInstalled(includeMl: boolean): Promise<string> {
    const venvPath = getHeadroomVenvPath();
    if (isHeadroomInstalled(venvPath)) {
      this.provisioningState = "installed";
      return getHeadroomBinary(venvPath);
    }

    const cfg = this.getConfig();
    if (!cfg.autoProvision) {
      throw new Error(
        "Headroom is not installed and autoProvision is disabled. Install 'headroom-ai[proxy]' or enable auto-provisioning in settings."
      );
    }

    this.provisioningState = "provisioning";
    this.emit("provisioning", { state: "provisioning" });

    const result = await provisionHeadroom({ includeMl });
    this.provisioningState = "installed";
    this.lastError = null;
    this.emit("provisioning", { state: "installed" });
    return result.headroomPath;
  }

  /**
   * Resolve the spawn context the pool needs (binary path + upstream URLs).
   * Returns null when headroom isn't installed yet — the pool then defers the
   * start until a later call finds it installed.
   */
  private resolveLaunchContext(): PoolLaunchContext | null {
    const venvPath = getHeadroomVenvPath();
    if (!isHeadroomInstalled(venvPath)) return null;
    const headroomPath = getHeadroomBinary(venvPath);
    // Collect upstream target URLs so the proxy forwards compressed requests to the
    // right endpoint (defaults to api.openai.com / api.anthropic.com when unset).
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const openaiConfig = providersConfig.openai as
      | { baseUrl?: string; baseURL?: string }
      | undefined;
    const anthropicConfig = providersConfig.anthropic as
      | { baseUrl?: string; baseURL?: string }
      | undefined;
    const openaiTargetUrl = openaiConfig?.baseUrl ?? openaiConfig?.baseURL ?? undefined;
    const anthropicBaseUrl = anthropicConfig?.baseUrl ?? anthropicConfig?.baseURL ?? undefined;
    return { headroomPath, openaiTargetUrl, anthropicBaseUrl };
  }

  /**
   * Explicitly trigger provisioning (e.g. from the UI "Provision" button).
   * Returns the final status.
   */
  async provision(): Promise<HeadroomStatus> {
    // Single-flight: a rapid double-click on "Provision" must not spawn two
    // parallel pip/uv installs against the same venv.
    if (this.provisionInFlight) return this.provisionInFlight;
    this.provisionInFlight = this.doProvision();
    try {
      return await this.provisionInFlight;
    } finally {
      this.provisionInFlight = null;
    }
  }

  private async doProvision(): Promise<HeadroomStatus> {
    const cfg = this.getConfig();
    try {
      this.provisioningState = "provisioning";
      this.emit("provisioning", { state: "provisioning" });
      const result = await provisionHeadroom({ includeMl: cfg.includeMl });
      this.provisioningState = "installed";
      this.lastError = null;
      this.emit("provisioning", { state: "installed" });
      log.info("[headroom] provisioning complete via UI trigger", {
        headroomPath: result.headroomPath,
      });

      // If already started but the global proxy wasn't running, start it now.
      if (this.started && !this.pool.getInfo(cfg) && !cfg.proxyBaseUrl) {
        await this.pool.startEntry(cfg);
      }
    } catch (err) {
      this.provisioningState = "failed";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit("provisioning", { state: "failed" });
    }
    return this.getStatus();
  }

  /**
   * Get the proxy base URL for the GLOBAL config's process (null if not running).
   * Kept for callers that don't have a workspace in scope. The factory uses
   * getProxyBaseUrlForConfig(effective) for per-workspace routing.
   */
  getProxyBaseUrl(): string | null {
    const cfg = this.getConfig();
    if (!cfg.enabled) return null;
    if (cfg.proxyBaseUrl) return cfg.proxyBaseUrl;
    return this.pool.getInfo(cfg)?.baseUrl ?? null;
  }

  /** Get the proxy base URL for a specific effective config (per-workspace pool
   *  routing). Lazily starts the matching process on first sight; returns null
   *  until that process is healthy (the request fails open). */
  getProxyBaseUrlForConfig(effective: HeadroomConfig): string | null {
    if (!effective.enabled) return null;
    if (effective.proxyBaseUrl) return effective.proxyBaseUrl;
    return this.pool.getOrStart(effective);
  }

  /** Current status snapshot for the UI (reflects the global-default process). */
  getStatus(): HeadroomStatus {
    const cfg = this.getConfig();
    const info = this.pool.getInfo(cfg);
    return {
      enabled: cfg.enabled,
      installed: isHeadroomInstalled(),
      provisioning: this.provisioningState,
      proxyRunning: info != null,
      proxyBaseUrl: cfg.proxyBaseUrl ?? info?.baseUrl ?? null,
      port: info?.port ?? null,
      runtimeMethod: resolveProvisioningMethod(),
      lastError: this.lastError,
      mode: cfg.mode,
      autoProvision: cfg.autoProvision,
      includeMl: cfg.includeMl,
      outputShaper: cfg.outputShaper,
      telemetry: cfg.telemetry,
      memoryEnabled: cfg.memory.enabled,
      perProvider: cfg.perProvider,
      advanced: cfg.advanced,
    };
  }

  /** Fetch live stats from the global proxy (null if unavailable). */
  async getStats(): Promise<HeadroomStats | null> {
    const baseUrl = this.getProxyBaseUrl();
    if (!baseUrl) return null;
    try {
      const client = new HeadroomClient(baseUrl);
      return await client.stats();
    } catch (err) {
      log.debug("[headroom] failed to fetch stats", { error: String(err) });
      return null;
    }
  }

  /**
   * Lazy-install the headroom-ai llmlingua extra (triggered when the user enables
   * LLMLingua in the Advanced panel). Returns a success/message pair for the UI.
   * Idempotent — safe to call when already installed.
   */
  async installLlmlingua(): Promise<{ success: boolean; message: string }> {
    try {
      await installHeadroomExtra("llmlingua");
      return { success: true, message: "LLMLingua installed successfully." };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("[headroom] llmlingua install failed", { error: message });
      return { success: false, message };
    }
  }

  /**
   * Run `headroom learn` to mine past sessions for failure patterns and write
   * corrections to AGENTS.md. Returns the CLI stdout (preview in dry-run mode).
   * @param apply When true, runs with --apply to write corrections to disk.
   */
  async learn(apply: boolean): Promise<string> {
    const headroomPath = getHeadroomBinary(getHeadroomVenvPath());
    if (!isHeadroomInstalled()) {
      throw new Error("Headroom is not installed. Provision it first via the settings UI.");
    }
    return new Promise<string>((resolve, reject) => {
      const args = ["learn"];
      if (apply) args.push("--apply");
      const child = spawn(headroomPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        timeout: 120_000,
      });
      const chunks: string[] = [];
      child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.on("close", (code) => {
        const output = chunks.join("");
        if (code === 0) {
          resolve(output);
        } else {
          reject(
            new Error(`headroom learn failed (exit ${code ?? "unknown"}): ${output.slice(0, 500)}`)
          );
        }
      });
      child.on("error", reject);
    });
  }

  /**
   * Get the MCP server config for the headroom MCP server (headroom_compress,
   * headroom_retrieve, headroom_stats tools). Returns the stdio command to register.
   */
  getMcpServerConfig(): { transport: "stdio"; command: string } | null {
    if (!isHeadroomInstalled()) return null;
    const headroomPath = getHeadroomBinary(getHeadroomVenvPath());
    // MCP stdio servers run the command string through `bash -c`, so the binary
    // path must be shell-quoted: a path with spaces (common on Windows user
    // dirs) would otherwise split the executable from the `mcp` argument.
    return { transport: "stdio", command: `${shellQuote(headroomPath)} mcp` };
  }

  /**
   * Restart the proxy (e.g. after config change). Safe to call when not running.
   */
  async restart(): Promise<HeadroomStatus> {
    // Single-flight: overlapping setConfig→restart calls (each UI toggle writes
    // config then restarts) must not race on the proxy process.
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart();
    try {
      return await this.restartInFlight;
    } finally {
      this.restartInFlight = null;
    }
  }

  private async doRestart(): Promise<HeadroomStatus> {
    const cfg = this.getConfig();
    if (cfg.enabled && !cfg.proxyBaseUrl) {
      try {
        await this.ensureInstalled(cfg.includeMl);
        // Restart the global-default entry. Per-workspace entries with a different
        // process config are lazily restarted on next use; the old entry is evicted
        // so a stale config can't linger (stop+start re-reads the current config).
        await this.pool.restartEntry(cfg);
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    } else {
      // Disabled or external proxy: stop any pooled processes we were managing.
      await this.pool.stopAll();
    }
    return this.getStatus();
  }
}

export interface HeadroomStats {
  total_requests?: number;
  tokens_saved?: number;
  savings_percent?: number;
  persistent_savings?: {
    total_tokens_saved?: number;
    total_requests?: number;
  };
}
