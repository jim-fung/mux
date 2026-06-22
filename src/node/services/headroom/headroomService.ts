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
import type { Config } from "@/node/config";
import type { HeadroomConfig } from "@/common/config/schemas/headroom";
import { log } from "@/node/services/log";
import {
  getHeadroomBinary,
  getHeadroomVenvPath,
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
    await this.proxy.start({
      headroomPath,
      telemetry: cfg.telemetry,
      outputShaper: cfg.outputShaper,
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
