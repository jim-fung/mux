/**
 * Headroom runtime provisioner.
 *
 * Auto-provisions an isolated Python venv at `~/.mux/headroom/` and installs
 * `headroom-ai[proxy]` (or `headroom-ai[proxy,ml]` when includeMl is set).
 *
 * Strategy (first available):
 *  1. `uv` (preferred — fast, can fetch a managed Python 3.10+)
 *  2. `python3 -m venv` + `pip install` (universal fallback)
 *
 * All operations are fail-safe and logged. Provisioning is opt-in (gated behind
 * config.headroom.enabled) and never runs at first launch without user action.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { log } from "@/node/services/log";
import { getMuxHome } from "@/common/constants/paths";

export type HeadroomRuntimeMethod = "uv" | "python3-venv" | "none";

export interface ProvisionResult {
  method: HeadroomRuntimeMethod;
  /** Path to the `headroom` executable inside the venv. */
  headroomPath: string;
  /** Path to the venv directory. */
  venvPath: string;
}

/** Detect whether a command is available on PATH (which/where). */
export function detectCommand(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(lookup, [command], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (result.status === 0) {
      const trimmed = result.stdout.trim().split("\n")[0];
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // which/where not available or command not found
  }
  return undefined;
}

/** Resolve the provisioning method based on available tooling. */
export function resolveProvisioningMethod(): HeadroomRuntimeMethod {
  if (detectCommand("uv")) return "uv";
  if (detectCommand("python3")) return "python3-venv";
  return "none";
}

/** Directory where the headroom venv + package lives. */
export function getHeadroomVenvPath(): string {
  return path.join(getMuxHome(), "headroom");
}

/** Platform-aware path to the headroom binary inside a venv. */
export function getHeadroomBinary(venvPath: string): string {
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "headroom.exe")
    : path.join(venvPath, "bin", "headroom");
}

/** Check if headroom is already installed in the venv. */
export function isHeadroomInstalled(venvPath?: string): boolean {
  const dir = venvPath ?? getHeadroomVenvPath();
  return existsSync(getHeadroomBinary(dir));
}

interface ProvisionOptions {
  includeMl?: boolean;
  /** Called with progress messages for UI display. */
  onProgress?: (message: string) => void;
}

/**
 * Provision the headroom runtime. Creates a venv and installs headroom-ai[proxy].
 * Returns the path to the headroom binary, or throws if provisioning fails.
 */
export function provisionHeadroom(options: ProvisionOptions = {}): Promise<ProvisionResult> {
  const venvPath = getHeadroomVenvPath();
  const { includeMl = false, onProgress = () => undefined } = options;
  const extras = includeMl ? "[proxy,ml]" : "[proxy]";

  return new Promise<ProvisionResult>((resolve, reject) => {
    const method = resolveProvisioningMethod();
    if (method === "none") {
      reject(
        new Error(
          "Neither 'uv' nor 'python3' found on PATH. Install one to use Headroom auto-provisioning, or run 'headroom proxy' manually."
        )
      );
      return;
    }

    mkdirSync(venvPath, { recursive: true });

    const runSteps = (
      steps: Array<{ cmd: string; args: string[]; label: string }>
    ): Promise<void> => {
      return steps.reduce(
        (promise, step) =>
          promise.then(() => {
            onProgress(step.label);
            log.info("[headroom] provisioning", { cmd: step.cmd, args: step.args });
            return new Promise<void>((ok, fail) => {
              const child = spawn(step.cmd, step.args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
              });
              collectOutput(child, step.label);
              child.on("close", (code) => {
                if (code === 0) ok();
                else fail(new Error(`${step.label} failed (exit ${code ?? "unknown"})`));
              });
              child.on("error", fail);
            });
          }),
        Promise.resolve()
      );
    };

    const steps: Array<{ cmd: string; args: string[]; label: string }> = [];

    if (method === "uv") {
      // uv creates a venv with python and can install directly.
      steps.push({
        cmd: "uv",
        args: ["venv", venvPath],
        label: "Creating venv with uv",
      });
      steps.push({
        cmd: "uv",
        args: ["pip", "install", "--python", venvPath, `headroom-ai${extras}`],
        label: `Installing headroom-ai${extras} with uv`,
      });
    } else {
      // python3 venv fallback
      steps.push({
        cmd: "python3",
        args: ["-m", "venv", venvPath],
        label: "Creating venv with python3",
      });
      const pipBin =
        process.platform === "win32"
          ? path.join(venvPath, "Scripts", "pip.exe")
          : path.join(venvPath, "bin", "pip");
      steps.push({
        cmd: pipBin,
        args: ["install", `headroom-ai${extras}`],
        label: `Installing headroom-ai${extras} with pip`,
      });
    }

    runSteps(steps)
      .then(() => {
        const headroomPath = getHeadroomBinary(venvPath);
        if (!existsSync(headroomPath)) {
          reject(new Error(`headroom binary not found at ${headroomPath} after install`));
          return;
        }
        log.info("[headroom] provisioning complete", { method, headroomPath });
        onProgress("Done");
        resolve({ method, headroomPath, venvPath });
      })
      .catch(reject);
  });
}

/** Capture stdout/stderr from a spawned process into the log for debugging. */
function collectOutput(child: ChildProcess, label: string): void {
  const chunks: string[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
  child.on("close", () => {
    const output = chunks.join("").trim();
    if (output.length > 0) {
      log.debug("[headroom] provision step output", { label, output: output.slice(0, 2000) });
    }
  });
}
