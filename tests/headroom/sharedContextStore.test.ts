import { afterEach, describe, expect, it } from "bun:test";
import { SharedContextStore } from "@/node/services/headroom/sharedContextStore";
import {
  HEADROOM_ADVANCED_DEFAULTS,
  HEADROOM_MEMORY_DEFAULTS,
  type HeadroomConfig,
} from "@/common/config/schemas/headroom";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal HeadroomService mock — only the methods SharedContextStore calls. */
function createMockHeadroomService(
  configOverrides: Partial<HeadroomConfig> = {},
  proxyBaseUrl: string | null = "http://127.0.0.1:9999"
) {
  const config: HeadroomConfig = {
    enabled: true,
    autoProvision: true,
    mode: "middleware",
    perProvider: {},
    includeMl: false,
    proxyBaseUrl: null,
    telemetry: false,
    outputShaper: false,
    memory: { ...HEADROOM_MEMORY_DEFAULTS, enabled: true },
    advanced: HEADROOM_ADVANCED_DEFAULTS,
    ...configOverrides,
  };

  return {
    getEffectiveConfig: () => config,
    getProxyBaseUrlForConfig: () => proxyBaseUrl,
  };
}

/** A report large enough to exceed the 500-token threshold (~4 chars/token → 2000+ chars). */
const LARGE_REPORT = "A".repeat(3000);
const COMPRESSED_REPORT = "B".repeat(800);

function setCompressFetch(compressed: string, tokensSaved = 1500): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonResponse({
        messages: [{ role: "user", content: compressed }],
        tokens_before: 750,
        tokens_after: 200,
        tokens_saved: tokensSaved,
        transforms_applied: ["SmartCrusher"],
        ccr_hashes: ["hash123"],
      })
    )) as unknown as typeof fetch;
}

function setErrorFetch(): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("error", { status: 500 }))) as unknown as typeof fetch;
}

describe("SharedContextStore", () => {
  describe("put — compression gating", () => {
    it("returns original when memory is disabled", async () => {
      const svc = createMockHeadroomService({
        memory: { ...HEADROOM_MEMORY_DEFAULTS, enabled: false },
      });
      const store = new SharedContextStore(svc as never);

      const result = await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(result.compressed).toBe(false);
      expect(result.deliveredContent).toBe(LARGE_REPORT);
      expect(result.tokensSaved).toBe(0);
    });

    it("returns original when below threshold", async () => {
      const svc = createMockHeadroomService();
      const store = new SharedContextStore(svc as never);

      const result = await store.put("k1", "short report", 3, { taskId: "t1" }, null);

      expect(result.compressed).toBe(false);
      expect(result.deliveredContent).toBe("short report");
      expect(store.keys()).toHaveLength(0);
    });

    it("returns original when proxy is unavailable", async () => {
      const svc = createMockHeadroomService({}, null);
      const store = new SharedContextStore(svc as never);

      const result = await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(result.compressed).toBe(false);
      expect(result.deliveredContent).toBe(LARGE_REPORT);
    });

    it("returns original when compression call fails", async () => {
      setErrorFetch();
      const svc = createMockHeadroomService();
      const store = new SharedContextStore(svc as never);

      const result = await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(result.compressed).toBe(false);
      expect(result.deliveredContent).toBe(LARGE_REPORT);
    });

    it("stores compressed content and returns it when compression succeeds", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const svc = createMockHeadroomService();
      const store = new SharedContextStore(svc as never);

      const result = await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(result.compressed).toBe(true);
      expect(result.deliveredContent).toBe(COMPRESSED_REPORT);
      expect(result.tokensSaved).toBe(1500);
      expect(store.keys()).toEqual(["k1"]);
    });
  });

  describe("get", () => {
    it("returns compressed content by default", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const store = new SharedContextStore(createMockHeadroomService() as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(store.get("k1")).toBe(COMPRESSED_REPORT);
    });

    it("returns original content with full option", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const store = new SharedContextStore(createMockHeadroomService() as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      expect(store.get("k1", { full: true })).toBe(LARGE_REPORT);
    });

    it("returns null for unknown key", () => {
      const store = new SharedContextStore(createMockHeadroomService() as never);
      expect(store.get("unknown")).toBeNull();
    });
  });

  describe("TTL eviction", () => {
    it("evicts expired entries on access", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const svc = createMockHeadroomService({
        memory: { ...HEADROOM_MEMORY_DEFAULTS, enabled: true, ttlSeconds: 1 },
      });
      const store = new SharedContextStore(svc as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);

      // Wait for TTL to expire (1 second + buffer).
      await new Promise((r) => setTimeout(r, 1100));

      expect(store.get("k1")).toBeNull();
      expect(store.has("k1")).toBe(false);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest-accessed entries when maxEntries is exceeded", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const svc = createMockHeadroomService({
        memory: { ...HEADROOM_MEMORY_DEFAULTS, enabled: true, maxEntries: 2 },
      });
      const store = new SharedContextStore(svc as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);
      await new Promise((r) => setTimeout(r, 5));
      await store.put("k2", LARGE_REPORT, 750, { taskId: "t2" }, null);
      await new Promise((r) => setTimeout(r, 5));
      // Access k1 to make k2 the LRU candidate
      store.get("k1");
      await new Promise((r) => setTimeout(r, 5));
      await store.put("k3", LARGE_REPORT, 750, { taskId: "t3" }, null);

      const keys = store.keys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain("k1");
      expect(keys).toContain("k3");
      expect(keys).not.toContain("k2");
    });
  });

  describe("stats", () => {
    it("reports entry count and token savings", async () => {
      setCompressFetch(COMPRESSED_REPORT, 1000);
      const store = new SharedContextStore(createMockHeadroomService() as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);
      await store.put("k2", LARGE_REPORT, 750, { taskId: "t2" }, null);

      const stats = store.stats();
      expect(stats.entries).toBe(2);
      expect(stats.compressedEntries).toBe(2);
      expect(stats.totalTokensSaved).toBe(2000);
    });
  });

  describe("clear / delete", () => {
    it("clear removes all entries", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const store = new SharedContextStore(createMockHeadroomService() as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);
      store.clear();

      expect(store.keys()).toHaveLength(0);
    });

    it("delete removes a single entry", async () => {
      setCompressFetch(COMPRESSED_REPORT);
      const store = new SharedContextStore(createMockHeadroomService() as never);

      await store.put("k1", LARGE_REPORT, 750, { taskId: "t1" }, null);
      expect(store.delete("k1")).toBe(true);
      expect(store.get("k1")).toBeNull();
      expect(store.delete("k1")).toBe(false);
    });
  });
});
