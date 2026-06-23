/**
 * Headroom proxy process lifecycle.
 *
 * Spawns `headroom proxy --host 127.0.0.1 --port <port> --no-telemetry` as a
 * detached child process, polls the `/health` endpoint until ready, and provides
 * a clean `stop()` that kills the process tree. Restart-on-crash and PID capture
 * ensure robustness — the proxy is an external process that may exit unexpectedly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { log } from "@/node/services/log";
import {
  type HeadroomAdvancedConfig,
  HEADROOM_ADVANCED_DEFAULTS,
} from "@/common/config/schemas/headroom";
import { HeadroomClient } from "./headroomClient";

/** Max time to wait for the proxy to become healthy after spawn. */
const STARTUP_TIMEOUT_MS = 30_000;
/** Interval between health-check polls during startup. */
const HEALTH_POLL_INTERVAL_MS = 1_000;
/** Grace period (ms) after SIGTERM before escalating to SIGKILL on stop(). */
const SIGKILL_GRACE_MS = 3_000;

export interface StartProxyOptions {
  headroomPath: string;
  /** Port to bind (random if omitted). */
  port?: number;
  telemetry?: boolean;
  outputShaper?: boolean;
  memoryEnabled?: boolean;
  /** Real upstream OpenAI API URL (for custom gateways/self-hosted). */
  openaiTargetUrl?: string;
  /** Real upstream Anthropic API URL (for custom gateways/self-hosted). */
  anthropicBaseUrl?: string;
  /** Fine-grained proxy knobs from the Advanced settings panel. */
  advanced?: HeadroomAdvancedConfig;
  /**
   * Invoked once if the proxy exits unexpectedly after a healthy start (a crash,
   * not an intentional stop()). Used by HeadroomService to relaunch.
   */
  onUnexpectedExit?: () => void;
}

export interface ProxyProcessInfo {
  baseUrl: string;
  port: number;
  pid: number;
}

export class HeadroomProxyProcess {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private port: number | null = null;
  /** Set when the process exits before health-check succeeds. Survives child
   *  nulling by the exit handler so waitForHealth can detect the crash. */
  private startupExited = false;
  /** True between a successful health-check and the next exit — distinguishes a
   *  post-startup crash (worth auto-restarting) from a startup failure. */
  private healthy = false;
  /** True once stop() has been called, so the exit handler can tell an
   *  intentional shutdown apart from an unexpected crash. */
  private intentionallyStopped = false;
  /** Crash callback supplied via start(); fired once on an unexpected exit. */
  private onUnexpectedExit?: () => void;

  get isRunning(): boolean {
    return this.child != null && !this.child.killed;
  }

  get info(): ProxyProcessInfo | null {
    if (!this.child || !this.baseUrl || this.port == null) return null;
    return {
      baseUrl: this.baseUrl,
      port: this.port,
      pid: this.child.pid ?? -1,
    };
  }

  /**
   * Spawn the proxy and wait for it to become healthy.
   * Rejects if the process exits during startup or the health check times out.
   */
  async start(options: StartProxyOptions): Promise<ProxyProcessInfo> {
    if (this.child) {
      throw new Error("Proxy process already running");
    }

    this.startupExited = false;
    this.healthy = false;
    this.intentionallyStopped = false;
    this.onUnexpectedExit = options.onUnexpectedExit;

    // Allocate a free loopback port ourselves and pass it to headroom explicitly.
    // This avoids scraping the proxy's stdout for the bound port (brittle if headroom
    // changes its log format); an explicit --port also makes detectPort trivial.
    const requested = options.port;
    const actualPort = requested && requested > 0 ? requested : await getFreePort();

    // buildProxyCommand is the single source of truth for the headroom argv + env
    // deltas — the previewCommand endpoint reuses it so the UI can never drift.
    const cmd = buildProxyCommand(
      {
        telemetry: options.telemetry ?? false,
        outputShaper: options.outputShaper ?? false,
        memoryEnabled: options.memoryEnabled ?? false,
        advanced: options.advanced ?? HEADROOM_ADVANCED_DEFAULTS,
      },
      String(actualPort)
    );
    const args = cmd.argv;
    const env: NodeJS.ProcessEnv = { ...process.env, ...cmd.env };
    // Real upstream URLs so the proxy forwards to the correct endpoint (defaults to
    // api.openai.com / api.anthropic.com when not set). These are runtime targets,
    // not part of the previewable spec, so they stay here rather than buildProxyCommand.
    if (options.openaiTargetUrl) {
      env.OPENAI_TARGET_API_URL = options.openaiTargetUrl;
    }
    if (options.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = options.anthropicBaseUrl;
    }

    log.info("[headroom] spawning proxy", { headroomPath: options.headroomPath, port: actualPort });

    this.child = spawn(options.headroomPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: true,
    });

    this.wireStdio();

    // Wait for the child to print its port (when port=0) or assume the requested port.
    const detectedPort = await this.detectPort(actualPort);
    this.port = detectedPort;
    this.baseUrl = `http://127.0.0.1:${detectedPort}`;

    // Health-check until ready.
    await this.waitForHealth();
    this.healthy = true;
    log.info("[headroom] proxy healthy", { baseUrl: this.baseUrl });

    return {
      baseUrl: this.baseUrl,
      port: detectedPort,
      pid: this.child.pid ?? -1,
    };
  }

  /** Try to read the actual port from stdout, or fall back to the requested one. */
  private detectPort(requested: number): Promise<number> {
    if (requested !== 0) return Promise.resolve(requested);

    // When port=0, headroom picks a random port and prints it to stdout.
    // We listen for a port pattern in the output with a short timeout.
    return new Promise<number>((resolve) => {
      const timeout = setTimeout(() => {
        // If we can't detect it, reject — caller should use a fixed port.
        resolve(-1);
      }, 5_000);

      this.child?.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const match = /(?:port[:\s]+|listening.*?)(\d{4,5})/i.exec(text);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolve(parseInt(match[1], 10));
        }
      });

      this.child?.on("close", () => {
        clearTimeout(timeout);
        resolve(-1);
      });
    });
  }

  /** Poll /health until it responds or the startup timeout elapses. */
  private async waitForHealth(): Promise<void> {
    if (!this.baseUrl || this.port === -1) {
      throw new Error("Could not determine proxy port");
    }

    const client = new HeadroomClient(this.baseUrl);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (true) {
      if (this.startupExited || this.child?.killed || this.child?.exitCode != null) {
        throw new Error("Proxy process exited during startup");
      }
      if (Date.now() > deadline) {
        throw new Error(`Proxy did not become healthy within ${STARTUP_TIMEOUT_MS}ms`);
      }
      try {
        await client.health();
        return;
      } catch {
        await sleep(HEALTH_POLL_INTERVAL_MS);
      }
    }
  }

  private wireStdio(): void {
    if (!this.child) return;
    const onExit = (code: number | null) => {
      log.info("[headroom] proxy process exited", { code });
      const wasHealthy = this.healthy;
      this.startupExited = true;
      this.healthy = false;
      this.child = null;
      this.baseUrl = null;
      this.port = null;
      // Only treat as a crash if the proxy had become healthy AND this wasn't an
      // intentional stop(). Fires once (state is nulled above).
      if (wasHealthy && !this.intentionallyStopped && this.onUnexpectedExit) {
        try {
          this.onUnexpectedExit();
        } catch (err) {
          log.warn("[headroom] unexpected-exit callback threw", { error: String(err) });
        }
      }
    };
    this.child.on("exit", onExit);
    this.child.on("error", (err) => {
      log.error("[headroom] proxy process error", { error: String(err) });
      onExit(null);
    });
    this.child.stdout?.on("data", (d: Buffer) => {
      log.debug("[headroom] proxy stdout", { line: d.toString().trim().slice(0, 500) });
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      log.debug("[headroom] proxy stderr", { line: d.toString().trim().slice(0, 500) });
    });
  }

  /**
   * Stop the proxy: SIGTERM the process group, then escalate to SIGKILL if it
   * hasn't exited within a short grace window. Safe to call multiple times.
   * Marked intentionallyStopped so the exit handler doesn't treat this as a crash.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const pid = child.pid;

    this.intentionallyStopped = true;
    log.info("[headroom] stopping proxy", { pid });

    try {
      // Kill the process group (detached: true means we can send to -pid).
      if (pid != null) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Fallback to killing just the process if the group kill fails.
          child.kill("SIGTERM");
        }
      }
    } catch (err) {
      log.warn("[headroom] error during proxy stop", { error: String(err) });
    }

    // Give the proxy a moment to exit gracefully, then force-kill the group.
    const exited = await waitForExit(child, SIGKILL_GRACE_MS);
    if (!exited && pid != null) {
      log.warn("[headroom] proxy did not exit on SIGTERM; sending SIGKILL", { pid });
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone — nothing to do.
        }
      }
    }

    this.healthy = false;
    this.child = null;
    this.baseUrl = null;
    this.port = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reserve an ephemeral loopback port by briefly listening, then releasing it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        server.close();
        reject(new Error("Could not allocate a free port for the headroom proxy"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

/** Resolve true once `child` exits, or false after `timeoutMs` with no exit. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Already exited.
    if (child.exitCode != null || child.signalCode != null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    // `.once` auto-removes on exit; resolve is idempotent so a late exit after a
    // timeout (we then SIGKILL) is harmless.
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Re-exported for callers that import the proxy command builder from the headroom
// service surface. The canonical definition lives in src/common (shared with the
// browser preview + previewCommand IPC endpoint) so the live spawn can never drift
// from the preview.
export { buildProxyCommand, type ProxyCommandSpec } from "@/common/config/headroomProxyCommand";
import { buildProxyCommand } from "@/common/config/headroomProxyCommand";
