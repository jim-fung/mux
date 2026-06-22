/**
 * Headroom proxy process lifecycle.
 *
 * Spawns `headroom proxy --host 127.0.0.1 --port <port> --no-telemetry` as a
 * detached child process, polls the `/health` endpoint until ready, and provides
 * a clean `stop()` that kills the process tree. Restart-on-crash and PID capture
 * ensure robustness — the proxy is an external process that may exit unexpectedly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { log } from "@/node/services/log";
import { HeadroomClient } from "./headroomClient";

/** Max time to wait for the proxy to become healthy after spawn. */
const STARTUP_TIMEOUT_MS = 30_000;
/** Interval between health-check polls during startup. */
const HEALTH_POLL_INTERVAL_MS = 1_000;

export interface StartProxyOptions {
  headroomPath: string;
  /** Port to bind (random if omitted). */
  port?: number;
  telemetry?: boolean;
  outputShaper?: boolean;
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

    const port = options.port ?? 0; // 0 = random ephemeral port (headroom picks one)
    // headroom uses --port to bind a specific port; for a random port we pass 0.
    const actualPort = port === 0 ? 0 : port;

    const args = ["proxy", "--host", "127.0.0.1", "--port", String(actualPort)];
    if (!options.telemetry) {
      args.push("--no-telemetry");
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.outputShaper) {
      env.HEADROOM_OUTPUT_SHAPER = "1";
    }
    if (!options.telemetry) {
      env.HEADROOM_TELEMETRY = "off";
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
      if (this.child?.killed || this.child?.exitCode != null) {
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
      this.child = null;
      this.baseUrl = null;
      this.port = null;
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

  /** Kill the proxy process tree. Safe to call multiple times. */
  stop(): void {
    const child = this.child;
    if (!child) return;

    log.info("[headroom] stopping proxy", { pid: child.pid });

    try {
      // Kill the process group (detached: true means we can send to -pid).
      if (child.pid != null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Fallback to killing just the process if the group kill fails.
          child.kill("SIGTERM");
        }
      }
    } catch (err) {
      log.warn("[headroom] error during proxy stop", { error: String(err) });
    }

    this.child = null;
    this.baseUrl = null;
    this.port = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
