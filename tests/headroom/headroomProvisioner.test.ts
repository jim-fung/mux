/**
 * Unit tests for the Headroom provisioner.
 *
 * Tests runtime detection (uv/python3/none), binary path construction, and the
 * provisioning command flow (success, failure, no-runtime). All child_process
 * and fs calls are mocked — no real venv creation or pip installs.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { jest } from "@jest/globals";

// Mock child_process and fs before importing the module under test.
const mockSpawnSync = jest.fn();
const mockSpawn = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

import {
  detectCommand,
  resolveProvisioningMethod,
  getHeadroomBinary,
  installHeadroomExtra,
  isHeadroomInstalled,
  provisionHeadroom,
} from "@/node/services/headroom/headroomProvisioner";

function fakeChildProcess(exitCode: number | null) {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const child = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
    },
    kill: jest.fn(),
    pid: 12345,
  };
  // Fire the close event asynchronously (like a real child process).
  setTimeout(() => {
    (handlers.close ?? []).forEach((cb) => cb(exitCode));
  }, 0);
  return child;
}

describe("detectCommand", () => {
  beforeEach(() => mockSpawnSync.mockReset());

  it("returns the path when which/where finds the command", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "/usr/local/bin/uv\n" });
    expect(detectCommand("uv")).toBe("/usr/local/bin/uv");
  });

  it("returns undefined when the command is not found", () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "" });
    expect(detectCommand("uv")).toBeUndefined();
  });

  it("returns undefined when which throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(detectCommand("uv")).toBeUndefined();
  });
});

describe("resolveProvisioningMethod", () => {
  beforeEach(() => mockSpawnSync.mockReset());

  it("prefers uv when available", () => {
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    expect(resolveProvisioningMethod()).toBe("uv");
  });

  it("falls back to python3-venv when uv is absent", () => {
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "python3") return { status: 0, stdout: "/usr/bin/python3" };
      return { status: 1, stdout: "" };
    });
    expect(resolveProvisioningMethod()).toBe("python3-venv");
  });

  it("returns none when neither uv nor python3 is available", () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "" });
    expect(resolveProvisioningMethod()).toBe("none");
  });
});

describe("getHeadroomBinary", () => {
  it("builds a unix path", () => {
    const bin = getHeadroomBinary("/home/user/.mux/headroom");
    // On non-win32 platforms the path uses bin/headroom
    if (process.platform !== "win32") {
      expect(bin).toContain("bin");
      expect(bin).toContain("headroom");
    }
  });
});

describe("isHeadroomInstalled", () => {
  beforeEach(() => mockExistsSync.mockReset());

  it("returns true when the binary exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(isHeadroomInstalled("/venv")).toBe(true);
  });

  it("returns false when the binary does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isHeadroomInstalled("/venv")).toBe(false);
  });
});

describe("provisionHeadroom", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
  });

  it("rejects when no runtime is available", async () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "" });
    await expect(provisionHeadroom()).rejects.toThrow("Neither 'uv' nor 'python3'");
  });

  it("provisions with uv when available and the binary appears", async () => {
    // uv detected
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    // Both spawn steps succeed — each call gets a fresh child process
    mockSpawn.mockImplementation(() => fakeChildProcess(0));
    // Binary exists after install
    mockExistsSync.mockReturnValue(true);

    const result = await provisionHeadroom({ includeMl: false });
    expect(result.method).toBe("uv");
    expect(mockMkdirSync).toHaveBeenCalled();
    // Two spawn calls: venv + pip install
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("provisions with python3-venv fallback when uv is absent", async () => {
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "python3") return { status: 0, stdout: "/usr/bin/python3" };
      return { status: 1, stdout: "" };
    });
    mockSpawn.mockImplementation(() => fakeChildProcess(0));
    mockExistsSync.mockReturnValue(true);

    const result = await provisionHeadroom();
    expect(result.method).toBe("python3-venv");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("rejects when a provisioning step fails", async () => {
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    // First step (venv creation) fails
    mockSpawn.mockImplementation(() => fakeChildProcess(1));

    await expect(provisionHeadroom()).rejects.toThrow("failed");
  });

  it("uses [proxy,ml] extras when includeMl is true", async () => {
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    const calls: Array<{ args: string[] }> = [];
    mockSpawn.mockImplementation((...args: unknown[]) => {
      calls.push({ args: args[1] as string[] });
      return fakeChildProcess(0);
    });
    mockExistsSync.mockReturnValue(true);

    await provisionHeadroom({ includeMl: true });

    // The install step should contain headroom-ai[proxy,ml]
    const installCall = calls.find((c) => c.args.some((a) => a.includes("headroom-ai")));
    expect(installCall).toBeDefined();
    expect(installCall!.args.some((a) => a.includes("[proxy,ml]"))).toBe(true);
  });
});

describe("installHeadroomExtra", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
  });

  it("rejects when headroom is not installed", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(installHeadroomExtra("llmlingua")).rejects.toThrow("not installed");
  });

  it("runs pip install headroom-ai[llmlingua] into the existing venv (uv)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    const calls: Array<{ args: string[] }> = [];
    mockSpawn.mockImplementation((...args: unknown[]) => {
      calls.push({ args: args[1] as string[] });
      return fakeChildProcess(0);
    });

    await installHeadroomExtra("llmlingua");

    // Only ONE spawn (pip install) — no venv creation.
    expect(calls).toHaveLength(1);
    expect(calls[0].args.some((a) => a.includes("headroom-ai[llmlingua]"))).toBe(true);
  });

  it("rejects when the pip install fails", async () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[];
      if (cmd[0] === "uv") return { status: 0, stdout: "/usr/local/bin/uv" };
      return { status: 1, stdout: "" };
    });
    mockSpawn.mockImplementation(() => fakeChildProcess(1));

    await expect(installHeadroomExtra("llmlingua")).rejects.toThrow("failed");
  });
});
