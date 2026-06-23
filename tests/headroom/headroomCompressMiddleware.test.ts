/**
 * Unit tests for the Headroom compression middleware.
 *
 * Tests the V3↔OpenAI message conversion, fail-open behavior, and the
 * compressed-text back-mapping. No real LLM or proxy calls — fetch is mocked.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { jest } from "@jest/globals";

// Mock fetch so tests never hit the network.
const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch as unknown as typeof fetch;

import { createHeadroomCompressMiddleware } from "@/node/services/headroom/headroomCompressMiddleware";

function makeParams(prompt: LanguageModelV3Prompt): LanguageModelV3CallOptions {
  return {
    prompt,
    maxOutputTokens: 1024,
    temperature: 0.7,
  };
}

describe("createHeadroomCompressMiddleware", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns specificationVersion v3", () => {
    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    expect(mw.specificationVersion).toBe("v3");
  });

  it("compresses text content and maps it back into V3 structure", async () => {
    // Simulate the proxy returning a shorter version of the text.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ role: "user", content: "COMPRESSED" }],
        tokens_before: 100,
        tokens_after: 10,
      }),
    } as Response);

    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    const result = await mw.transformParams!({
      type: "stream",
      params: makeParams([
        {
          role: "user",
          content: [{ type: "text", text: "A very long message that should be compressed" }],
        },
      ]) as never,
      model: {} as never,
    });

    const msg = (result.prompt as unknown[])[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(msg.content[0].text).toBe("COMPRESSED");
  });

  it("fails open — returns original params when the proxy returns an error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    } as Response);

    const original = makeParams([{ role: "user", content: [{ type: "text", text: "original" }] }]);
    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    const result = await mw.transformParams!({
      type: "stream",
      params: original as never,
      model: {} as never,
    });

    // On error, the original prompt is returned unchanged.
    expect(result.prompt).toBe(original.prompt);
  });

  it("fails open — returns original params when fetch throws (proxy down)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const original = makeParams([{ role: "user", content: [{ type: "text", text: "original" }] }]);
    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    const result = await mw.transformParams!({
      type: "stream",
      params: original as never,
      model: {} as never,
    });

    expect(result.prompt).toBe(original.prompt);
  });

  it("preserves non-text content parts (tool calls, images) unchanged", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          {
            role: "assistant",
            content: "COMPRESSED TEXT",
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      }),
    } as Response);

    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    const result = await mw.transformParams!({
      type: "stream",
      params: makeParams([
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will read the file now." },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
          ],
        },
      ]) as never,
      model: {} as never,
    });

    const msg = (result.prompt as unknown[])[0] as {
      content: Array<{ type: string; text?: string; toolName?: string }>;
    };
    // Text part is replaced with compressed content.
    expect(msg.content[0].text).toBe("COMPRESSED TEXT");
    // Tool call part is preserved unchanged.
    expect(msg.content[1].toolName).toBe("read");
  });

  it("returns original params when prompt is empty", async () => {
    const mw = createHeadroomCompressMiddleware({ proxyBaseUrl: "http://localhost:8787" });
    const original = makeParams([]);
    const result = await mw.transformParams!({
      type: "stream",
      params: original as never,
      model: {} as never,
    });
    expect(result).toBe(original);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
