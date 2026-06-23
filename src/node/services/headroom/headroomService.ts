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
import type { HeadroomConfig, HeadroomAdvancedConfig } from "@/common/config/schemas/headroom";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";
import { log } from "@/node/services/log";
import {
  getHeadroomBinary,
  getHeadroomVenvPath,
  installHeadroomExtra,
  isHeadroomInstalled,
  provisionHeadroom,
  resolveProvisioningMethod,
  type HeadroomRuntimeMethod,
} from "./headroomProvisioner";
import { HeadroomProxyProcess } from "./headroomProxyProcess";
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
  private readonly proxy: HeadroomProxyProcess = new HeadroomProxyProcess();
  private provisioningState: HeadroomProvisioningState = "not-installed";
  private lastError: string | null = null;
  private started = false;

  constructor(private readonly config: Config) {
    super();
  }

  /** Read the current headroom config (live, from disk). */
  getConfig(): HeadroomConfig {
    const onDisk = this.config.loadConfigOrDefault();
    return (
      onDisk.headroom ?? {
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
      }
    );
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

    // If the user configured an external proxyBaseUrl, we don't manage a process.
    if (cfg.proxyBaseUrl) {
      log.info("[headroom] using external proxy", { baseUrl: cfg.proxyBaseUrl });
      return;
    }

    try {
      await this.ensureInstalled(cfg.includeMl);
      await this.launchProxy(cfg);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn("[headroom] failed to start proxy (chat will continue uncompressed)", {
        error: this.lastError,
      });
      // Don't throw — fail-open at the service level too.
    }
  }

  /** Stop the proxy process. Called from ServiceContainer.dispose(). */
  stop(): void {
    this.started = false;
    this.proxy.stop();
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

  /** Launch the proxy process (if not already using an external URL). */
  private async launchProxy(cfg: HeadroomConfig): Promise<void> {
    const headroomPath = getHeadroomBinary(getHeadroomVenvPath());

    // Collect upstream target URLs from the providers config so the proxy knows
    // where to forward compressed requests. Without this, proxy mode breaks on
    // providers with custom baseURLs (gateways, self-hosted, proxies).
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const openaiConfig = providersConfig.openai as
      | { baseUrl?: string; baseURL?: string }
      | undefined;
    const anthropicConfig = providersConfig.anthropic as
      | { baseUrl?: string; baseURL?: string }
      | undefined;
    const openaiTargetUrl = openaiConfig?.baseUrl ?? openaiConfig?.baseURL ?? undefined;
    const anthropicBaseUrl = anthropicConfig?.baseUrl ?? anthropicConfig?.baseURL ?? undefined;

    await this.proxy.start({
      headroomPath,
      telemetry: cfg.telemetry,
      outputShaper: cfg.outputShaper,
      memoryEnabled: cfg.memory.enabled,
      openaiTargetUrl,
      anthropicBaseUrl,
      advanced: cfg.advanced,
    });
  }

  /**
   * Explicitly trigger provisioning (e.g. from the UI "Provision" button).
   * Returns the final status.
   */
  async provision(): Promise<HeadroomStatus> {
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

      // If already started but proxy wasn't running, try to launch now.
      if (this.started && !this.proxy.isRunning && !cfg.proxyBaseUrl) {
        await this.launchProxy(cfg);
      }
    } catch (err) {
      this.provisioningState = "failed";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit("provisioning", { state: "failed" });
    }
    return this.getStatus();
  }

  /** Get the proxy base URL for the factory to connect to (null if not running). */
  getProxyBaseUrl(): string | null {
    const cfg = this.getConfig();
    if (!cfg.enabled) return null;
    if (cfg.proxyBaseUrl) return cfg.proxyBaseUrl;
    return this.proxy.info?.baseUrl ?? null;
  }

  /** Current status snapshot for the UI. */
  getStatus(): HeadroomStatus {
    const cfg = this.getConfig();
    const info = this.proxy.info;
    return {
      enabled: cfg.enabled,
      installed: isHeadroomInstalled(),
      provisioning: this.provisioningState,
      proxyRunning: this.proxy.isRunning,
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

  /** Fetch live stats from the proxy (null if unavailable). */
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
    return { transport: "stdio", command: `${headroomPath} mcp` };
  }

  /**
   * Restart the proxy (e.g. after config change). Safe to call when not running.
   */
  async restart(): Promise<HeadroomStatus> {
    this.proxy.stop();
    const cfg = this.getConfig();
    if (cfg.enabled && !cfg.proxyBaseUrl) {
      try {
        await this.ensureInstalled(cfg.includeMl);
        await this.launchProxy(cfg);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
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
