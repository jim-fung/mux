/**
 * Headroom proxy HTTP client.
 *
 * Thin wrapper around fetch that talks to the local `headroom proxy` instance.
 * The proxy exposes:
 *   POST /v1/compress     — compress messages without an LLM call (returns compressed messages)
 *   POST /v1/retrieve     — retrieve original (uncompressed) content by CCR hash
 *   GET  /health          — liveness + session stats
 *   GET  /stats           — detailed statistics
 *
 * All methods are fail-safe: network/parse errors throw, but callers (notably the
 * compression middleware) catch and degrade gracefully so chat is never blocked.
 */

export interface HeadroomCompressRequest {
  messages: unknown[];
  model?: string;
}

export interface HeadroomCompressResponse {
  messages: unknown[];
  tokens_before?: number;
  tokens_after?: number;
  tokens_saved?: number;
  compression_ratio?: number;
  transforms_applied?: string[];
  ccr_hashes?: string[];
}

export interface HeadroomHealth {
  status: string;
  optimize?: boolean;
  stats?: {
    total_requests?: number;
    tokens_saved?: number;
    savings_percent?: number;
  };
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

/** Default request timeout for compress calls (compression must not stall chat). */
const COMPRESS_TIMEOUT_MS = 15_000;
/** Short timeout for health checks during startup polling. */
const HEALTH_TIMEOUT_MS = 3_000;

function withTimeout(timeoutMs: number): { signal: AbortSignal } {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal };
}

export class HeadroomClient {
  constructor(private readonly baseUrl: string) {}

  /** POST /v1/compress — compress OpenAI-format messages. Returns originals on failure. */
  async compress(messages: unknown[], model?: string): Promise<HeadroomCompressResponse> {
    const body: HeadroomCompressRequest = { messages };
    if (model != null) {
      body.model = model;
    }
    const res = await fetch(`${this.baseUrl}/v1/compress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...withTimeout(COMPRESS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Headroom compress failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as HeadroomCompressResponse;
  }

  /** GET /health — liveness probe. */
  async health(): Promise<HeadroomHealth> {
    const res = await fetch(`${this.baseUrl}/health`, {
      ...withTimeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Headroom health check failed: ${res.status}`);
    }
    return (await res.json()) as HeadroomHealth;
  }

  /** GET /stats — detailed statistics. */
  async stats(): Promise<HeadroomStats> {
    const res = await fetch(`${this.baseUrl}/stats`);
    if (!res.ok) {
      throw new Error(`Headroom stats failed: ${res.status}`);
    }
    return (await res.json()) as HeadroomStats;
  }
}
