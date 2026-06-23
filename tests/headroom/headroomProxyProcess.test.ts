/**
 * Unit tests for the Headroom proxy process lifecycle.
 *
 * Tests start (health ok), failure on exit-during-startup, stop (process kill),
 * and the info getter. Spawning and fetch are mocked — no real proxy process.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { jest } from "@jest/globals";

const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch as unknown as typeof fetch;

const mockSpawn = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { HeadroomProxyProcess, applyAdvanced } from "@/node/services/headroom/headroomProxyProcess";
import { HEADROOM_ADVANCED_DEFAULTS } from "@/common/config/schemas/headroom";

function makeFakeChild(portOutput?: string, immediateExit?: number) {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const child = {
    stdout: {
      on: (event: string, cb: (d: Buffer) => void) => {
        if (event === "data" && portOutput) {
          setTimeout(() => cb(Buffer.from(portOutput)), 0);
        }
      },
    },
    stderr: { on: () => {} },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
      if (immediateExit != null && event === "exit") {
        setTimeout(() => cb(immediateExit), 5);
      }
    },
    kill: jest.fn(),
    killed: false,
    exitCode: null,
    pid: 99999,
  };
  return { child, handlers };
}

describe("HeadroomProxyProcess", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockFetch.mockReset();
  });

  it("starts and resolves when health check succeeds", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    // Health check returns ok
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy" }),
    } as Response);

    const proxy = new HeadroomProxyProcess();
    const info = await proxy.start({ headroomPath: "/fake/headroom", port: 8787 });

    expect(info.port).toBe(8787);
    expect(info.baseUrl).toBe("http://127.0.0.1:8787");
    expect(proxy.isRunning).toBe(true);

    // Clean up
    proxy.stop();
  });

  it("rejects when the process exits during startup", async () => {
    const { child } = makeFakeChild(undefined, 1);
    mockSpawn.mockReturnValue(child);
    // Health check must FAIL so the polling loop is still retrying when the
    // exit event fires. Otherwise the health check resolves before exit.
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const proxy = new HeadroomProxyProcess();
    await expect(proxy.start({ headroomPath: "/fake/headroom", port: 8787 })).rejects.toThrow(
      "exited during startup"
    );
  });

  it("detects the port from stdout when port is 0", async () => {
    const { child } = makeFakeChild("Starting headroom proxy on port 9123");
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy" }),
    } as Response);

    const proxy = new HeadroomProxyProcess();
    const info = await proxy.start({ headroomPath: "/fake/headroom", port: 0 });

    expect(info.port).toBe(9123);
    proxy.stop();
  });

  it("stop() is safe to call when not running", () => {
    const proxy = new HeadroomProxyProcess();
    // Should not throw
    proxy.stop();
    expect(proxy.isRunning).toBe(false);
  });

  it("stop() is safe to call multiple times", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy" }),
    } as Response);

    const proxy = new HeadroomProxyProcess();
    await proxy.start({ headroomPath: "/fake/headroom", port: 8787 });
    proxy.stop();
    proxy.stop(); // second call is a no-op
    expect(proxy.isRunning).toBe(false);
  });

  it("rejects if start() is called while already running", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy" }),
    } as Response);

    const proxy = new HeadroomProxyProcess();
    await proxy.start({ headroomPath: "/fake/headroom", port: 8787 });
    await expect(proxy.start({ headroomPath: "/fake/headroom", port: 8787 })).rejects.toThrow(
      "already running"
    );

    proxy.stop();
  });
});

describe("applyAdvanced", () => {
  function setup() {
    return { args: [] as string[], env: {} as Record<string, string> };
  }

  it("adds no flags when all defaults are used", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, HEADROOM_ADVANCED_DEFAULTS);
    expect(args).toEqual([]);
    // Context tool + log level are always set (they have no proxy default).
    expect(env.HEADROOM_CONTEXT_TOOL).toBe("rtk");
    expect(env.HEADROOM_LOG_LEVEL).toBe("INFO");
    // Holdout not set when 0.
    expect(env.HEADROOM_OUTPUT_HOLDOUT).toBeUndefined();
  });

  it("pushes --no-intelligent-context when disabled", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, { ...HEADROOM_ADVANCED_DEFAULTS, intelligentContext: false });
    expect(args).toContain("--no-intelligent-context");
    expect(args).not.toContain("--no-intelligent-scoring");
  });

  it("pushes --no-optimize when disabled", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, { ...HEADROOM_ADVANCED_DEFAULTS, optimize: false });
    expect(args).toContain("--no-optimize");
  });

  it("pushes --llmlingua with device + rate when enabled", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, {
      ...HEADROOM_ADVANCED_DEFAULTS,
      llmlingua: true,
      llmlinguaDevice: "cuda",
      llmlinguaRate: 0.2,
    });
    expect(args).toContain("--llmlingua");
    expect(args).toContain("--llmlingua-device");
    expect(args).toContain("cuda");
    expect(args).toContain("--llmlingua-rate");
    expect(args).toContain("0.2");
  });

  it("pushes --budget when budgetUsd is set", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, { ...HEADROOM_ADVANCED_DEFAULTS, budgetUsd: 50 });
    expect(args).toContain("--budget");
    expect(args).toContain("50");
  });

  it("sets HEADROOM_OUTPUT_HOLDOUT when holdout > 0", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, { ...HEADROOM_ADVANCED_DEFAULTS, outputHoldout: 0.1 });
    expect(env.HEADROOM_OUTPUT_HOLDOUT).toBe("0.1");
  });

  it("merges customEnv and appends extraArgs last (power-user wins)", () => {
    const { args, env } = setup();
    applyAdvanced(args, env, {
      ...HEADROOM_ADVANCED_DEFAULTS,
      customEnv: { MY_KEY: "my-value" },
      extraArgs: ["--custom-flag", "value"],
    });
    expect(env.MY_KEY).toBe("my-value");
    // extraArgs are appended after everything.
    expect(args[args.length - 2]).toBe("--custom-flag");
    expect(args[args.length - 1]).toBe("value");
  });
});
