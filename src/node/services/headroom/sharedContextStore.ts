/**
 * SharedContextStore — in-process KV store for compressed subagent reports.
 *
 * When Headroom's shared-context memory is enabled (memory.enabled in HeadroomConfig),
 * subagent reports are compressed at delivery time via the proxy's /v1/compress
 * endpoint and stored here keyed by task group. The parent agent receives the
 * compressed text in its chat.jsonl; the original can be retrieved from this store
 * (in-memory, fast) or from disk (subagent-reports/<taskId>/report.json, durable).
 *
 * Lifecycle: created in ServiceContainer alongside HeadroomService. In-memory only —
 * cleared on process restart (disk artifacts survive as fallback). Entries expire
 * via TTL and are evicted via LRU when maxEntries is exceeded.
 *
 * Fail-open: if the proxy is unavailable or compression fails, the report is
 * delivered uncompressed and nothing is stored.
 */

import type { HeadroomService } from "./headroomService";
import { HeadroomClient } from "./headroomClient";
import type { HeadroomContentCompressionResult } from "./headroomClient";
import { log } from "@/node/services/log";

export interface SharedContextEntry {
  key: string;
  compressedContent: string;
  originalContent: string;
  meta: {
    taskId: string;
    groupId?: string;
    agentType?: string;
    title?: string;
  };
  ccrHashes?: string[];
  tokensSaved?: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
}

export interface SharedContextPutResult {
  /** The store key (same as input). */
  key: string;
  /** Whether compression was applied (false if below threshold or compression failed). */
  compressed: boolean;
  /** Estimated tokens saved by compression (0 if uncompressed). */
  tokensSaved: number;
  /** The content to deliver to the parent (compressed or original). */
  deliveredContent: string;
}

export interface SharedContextStats {
  entries: number;
  compressedEntries: number;
  totalTokensSaved: number;
}

/** Fallback token estimate when the proxy doesn't report tokensAfter. */
const CHARS_PER_TOKEN_FALLBACK = 4;

export class SharedContextStore {
  private readonly entries = new Map<string, SharedContextEntry>();
  private readonly clientCache = new Map<string, HeadroomClient>();

  constructor(private readonly headroomService: HeadroomService) {}

  /**
   * Store a report with optional compression. If the report exceeds the workspace's
   * compressThresholdTokens and the proxy is available, the content is compressed
   * via /v1/compress before storage. Returns the content to deliver to the parent
   * (compressed or original).
   *
   * Fail-open: any proxy/compression failure returns the original content uncompressed.
   */
  async put(
    key: string,
    originalContent: string,
    tokenEstimate: number,
    meta: SharedContextEntry["meta"],
    workspaceId: string | null
  ): Promise<SharedContextPutResult> {
    const effective = this.headroomService.getEffectiveConfig(workspaceId);
    const now = Date.now();
    const ttlMs = effective.memory.ttlSeconds * 1000;

    // Memory feature disabled — deliver uncompressed.
    if (!effective.memory.enabled) {
      return { key, compressed: false, tokensSaved: 0, deliveredContent: originalContent };
    }

    // Below threshold — deliver uncompressed, don't store.
    if (tokenEstimate < effective.memory.compressThresholdTokens) {
      return { key, compressed: false, tokensSaved: 0, deliveredContent: originalContent };
    }

    // Attempt compression via the proxy. Non-blocking: returns null if the proxy
    // isn't healthy yet (getProxyBaseUrlForConfig background-starts on first call
    // but returns null until the process is ready).
    const baseUrl = this.headroomService.getProxyBaseUrlForConfig(effective);
    let compression: HeadroomContentCompressionResult | null = null;
    if (baseUrl) {
      const client = this.getOrCreateClient(baseUrl);
      compression = await client.compressContent(originalContent);
    }

    // Compression failed or produced no change — deliver original.
    if (compression == null || compression.compressedText === originalContent) {
      return { key, compressed: false, tokensSaved: 0, deliveredContent: originalContent };
    }

    const tokensSaved =
      compression.tokensSaved ??
      Math.max(
        0,
        tokenEstimate -
          (compression.tokensAfter ??
            Math.floor(compression.compressedText.length / CHARS_PER_TOKEN_FALLBACK))
      );

    const entry: SharedContextEntry = {
      key,
      compressedContent: compression.compressedText,
      originalContent,
      meta,
      ccrHashes: compression.ccrHashes,
      tokensSaved,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs,
    };

    this.evictExpired(now);
    this.entries.set(key, entry);
    this.enforceMaxEntries(effective.memory.maxEntries);

    log.debug("[shared-context] stored compressed report", {
      key,
      tokensSaved,
      tokensBefore: compression.tokensBefore,
      tokensAfter: compression.tokensAfter,
    });

    return {
      key,
      compressed: true,
      tokensSaved,
      deliveredContent: compression.compressedText,
    };
  }

  /**
   * Retrieve an entry by key. Returns the compressed content by default, or the
   * original if `full` is true. Returns null if the key is unknown or expired.
   */
  get(key: string, options?: { full?: boolean }): string | null {
    const entry = this.entries.get(key);
    if (entry == null) return null;
    const now = Date.now();
    if (entry.expiresAt < now) {
      this.entries.delete(key);
      return null;
    }
    entry.lastAccessedAt = now;
    return options?.full ? entry.originalContent : entry.compressedContent;
  }

  /** Check whether a key exists and is not expired. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry == null) return false;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** All live keys (expired entries are swept). */
  keys(): string[] {
    this.evictExpired(Date.now());
    return [...this.entries.keys()];
  }

  /** Aggregate stats for observability. */
  stats(): SharedContextStats {
    this.evictExpired(Date.now());
    let totalTokensSaved = 0;
    let compressedEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.tokensSaved != null && entry.tokensSaved > 0) {
        totalTokensSaved += entry.tokensSaved;
        compressedEntries++;
      }
    }
    return {
      entries: this.entries.size,
      compressedEntries,
      totalTokensSaved,
    };
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Delete a single entry. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  // --- internals ---

  private getOrCreateClient(baseUrl: string): HeadroomClient {
    let client = this.clientCache.get(baseUrl);
    if (client == null) {
      client = new HeadroomClient(baseUrl);
      this.clientCache.set(baseUrl, client);
    }
    return client;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
      }
    }
  }

  private enforceMaxEntries(maxEntries: number): void {
    if (this.entries.size <= maxEntries) return;
    // Evict by oldest lastAccessedAt (LRU).
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
    );
    const toEvict = sorted.length - maxEntries;
    for (let i = 0; i < toEvict; i++) {
      this.entries.delete(sorted[i][0]);
    }
  }
}
