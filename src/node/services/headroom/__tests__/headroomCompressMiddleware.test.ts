import { afterEach, describe, expect, it } from "bun:test";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createHeadroomCompressMiddleware } from "@/node/services/headroom/headroomCompressMiddleware";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createMockModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("unused")),
    doStream: () => Promise.reject(new Error("unused")),
  };
}

/** Two text-bearing messages → both are sent to /v1/compress (sentCount = 2). */
function createParams(): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: "system", content: "Be concise" },
      { role: "user", content: [{ type: "text", text: "Hello world" }] },
    ],
    maxOutputTokens: 128,
    temperature: 0.7,
    toolChoice: { type: "auto" },
    providerOptions: {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Replace global fetch for a test. The callable signature is all the middleware
 *  uses; the static `preconnect` member of `typeof fetch` is irrelevant here, so a
 *  targeted assertion keeps the mock concise. */
function setFetch(fn: () => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

/** Read the user message's first text part (the part the middleware rewrites). */
function userText(params: LanguageModelV3CallOptions): string {
  const prompt = params.prompt as unknown as Array<{
    role: string;
    content: unknown;
  }>;
  const user = prompt.find((m) => m.role === "user");
  const parts = user?.content as Array<{ type: string; text?: string }> | undefined;
  return parts?.[0]?.text ?? "";
}

describe("headroomCompressMiddleware", () => {
  it("returns the original prompt unchanged when the proxy returns a mismatched message count", async () => {
    // We send 2 messages but the proxy only returns 1 — the positional cursor
    // would mis-align, so the middleware must bail and fail open.
    setFetch(() => Promise.resolve(jsonResponse({ messages: [{ role: "system", content: "x" }] })));

    const middleware = createHeadroomCompressMiddleware({
      proxyBaseUrl: "http://127.0.0.1:9999",
      modelId: "test-model",
    });
    const params = createParams();
    const result = await middleware.transformParams!({
      type: "stream",
      params,
      model: createMockModel(),
    });

    // Bail returns the exact same params object (no rewrite).
    expect(result).toBe(params);
    expect(userText(result)).toBe("Hello world");
  });

  it("applies compressed text positionally when the message counts match", async () => {
    setFetch(() =>
      Promise.resolve(
        jsonResponse({
          messages: [
            { role: "system", content: "Be brief" },
            { role: "user", content: "SUMMARY" },
          ],
        })
      )
    );

    const middleware = createHeadroomCompressMiddleware({
      proxyBaseUrl: "http://127.0.0.1:9999",
      modelId: "test-model",
    });
    const params = createParams();
    const result = await middleware.transformParams!({
      type: "stream",
      params,
      model: createMockModel(),
    });

    expect(result).not.toBe(params);
    expect(userText(result)).toBe("SUMMARY");
  });

  it("fails open (unchanged prompt) when the proxy call rejects", async () => {
    setFetch(() => Promise.reject(new Error("proxy down")));

    const middleware = createHeadroomCompressMiddleware({
      proxyBaseUrl: "http://127.0.0.1:9999",
      modelId: "test-model",
    });
    const params = createParams();
    const result = await middleware.transformParams!({
      type: "stream",
      params,
      model: createMockModel(),
    });

    expect(result).toBe(params);
    expect(userText(result)).toBe("Hello world");
  });
});
