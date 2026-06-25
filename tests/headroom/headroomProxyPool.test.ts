import { describe, expect, it } from "bun:test";
import { HeadroomProxyPool } from "@/node/services/headroom/headroomProxyPool";
import type { HeadroomProxyProcess } from "@/node/services/headroom/headroomProxyProcess";
import type { HeadroomConfig } from "@/common/config/schemas/headroom";
import {
  HEADROOM_ADVANCED_DEFAULTS,
  HEADROOM_MEMORY_DEFAULTS,
} from "@/common/config/schemas/headroom";

const baseCfg: HeadroomConfig = {
  enabled: true,
  autoProvision: true,
  mode: "off",
  perProvider: {},
  includeMl: false,
  proxyBaseUrl: null,
  telemetry: false,
  outputShaper: false,
  memory: HEADROOM_MEMORY_DEFAULTS,
  advanced: HEADROOM_ADVANCED_DEFAULTS,
};

/** A fake process that resolves start() immediately and records stop() calls. */
function makeFakeProcess(
  baseUrl = "http://127.0.0.1:1"
): HeadroomProxyProcess & { stopped: boolean } {
  const fake = {
    stopped: false,
    isRunning: true,
    info: { baseUrl, port: 1, pid: 1 },
    async start() {
      return { baseUrl, port: 1, pid: 1 };
    },
    async stop() {
      fake.stopped = true;
    },
  };
  return fake as unknown as HeadroomProxyProcess & { stopped: boolean };
}

/** Pool whose resolveContext always succeeds (headroom "installed"). */
function makePool(
  maxPoolSize = 4,
  idleEvictMs = 5 * 60_000,
  context = { headroomPath: "/fake/headroom" }
) {
  const created: Array<HeadroomProxyProcess & { stopped: boolean }> = [];
  const pool = new HeadroomProxyPool(
    () => context,
    maxPoolSize,
    idleEvictMs,
    () => {
      const p = makeFakeProcess(`http://127.0.0.1:${created.length + 1}`);
      created.push(p);
      return p;
    }
  );
  return { pool, created };
}

describe("HeadroomProxyPool", () => {
  it("getOrStart returns null on first sight (background spawn), baseUrl after", async () => {
    const { pool } = makePool();
    const first = pool.getOrStart(baseCfg);
    expect(first).toBeNull(); // not healthy yet — fails open
    // Background start resolves quickly; a follow-up call finds it running.
    await new Promise((r) => setTimeout(r, 5));
    const second = pool.getOrStart(baseCfg);
    expect(second).toMatch(new RegExp("^http://127.0.0.1"));
    pool.dispose();
  });

  it("same process config reuses one entry", async () => {
    const { pool, created } = makePool();
    pool.getOrStart(baseCfg);
    await new Promise((r) => setTimeout(r, 5));
    pool.getOrStart({ ...baseCfg }); // structurally identical
    expect(created.length).toBe(1);
    expect(pool.size).toBe(1);
    pool.dispose();
  });

  it("diverging process config spawns a second entry", async () => {
    const { pool, created } = makePool();
    pool.getOrStart(baseCfg);
    pool.getOrStart({ ...baseCfg, telemetry: true });
    expect(pool.size).toBe(2);
    expect(created.length).toBe(2);
    pool.dispose();
  });

  it("enforces the size cap via LRU eviction", async () => {
    const { pool, created } = makePool(2);
    pool.getOrStart(baseCfg);
    pool.getOrStart({ ...baseCfg, telemetry: true });
    pool.getOrStart({ ...baseCfg, outputShaper: true }); // evicts LRU (baseCfg)
    expect(pool.size).toBe(2);
    expect(created.length).toBe(3);
    pool.dispose();
  });

  it("stopAll stops every entry and clears the pool", async () => {
    const { pool, created } = makePool();
    pool.getOrStart(baseCfg);
    pool.getOrStart({ ...baseCfg, telemetry: true });
    await pool.stopAll();
    expect(pool.size).toBe(0);
    expect(created.every((p) => p.stopped)).toBe(true);
    pool.dispose();
  });

  it("restartEntry stops then restarts the entry for a config", async () => {
    const { pool, created } = makePool();
    pool.getOrStart(baseCfg);
    await new Promise((r) => setTimeout(r, 5));
    await pool.restartEntry(baseCfg);
    expect(pool.size).toBe(1);
    // A fresh process was created (the old one stopped).
    const stoppedCount = created.filter((p) => p.stopped).length;
    expect(stoppedCount).toBeGreaterThanOrEqual(1);
    pool.dispose();
  });
});
