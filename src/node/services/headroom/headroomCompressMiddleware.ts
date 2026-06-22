/**
 * Headroom compression middleware (LanguageModelV3Middleware).
 *
 * Intercepts every provider request at the LanguageModel level and compresses
 * the prompt before it reaches the model. Uses the proxy's `/v1/compress` endpoint
 * (compression-only, no LLM call).
 *
 * Design:
 *  - `transformParams` converts the Vercel AI SDK V3 prompt → OpenAI chat format,
 *    POSTs to /v1/compress, and maps the compressed text back into the original
 *    V3 message structure (non-text parts like images/tool-calls are preserved).
 *  - **Fail-open**: on any error (proxy down, timeout, parse failure), the original
 *    params are returned unchanged so chat is never blocked. This is the single
 *    most important safety property — a compression proxy must never break the app.
 *
 * See: https://headroom-docs.vercel.app/docs/proxy#post-v1compress
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import { HeadroomClient } from "./headroomClient";

/**
 * A V3 prompt message is structurally { role, content: ContentPart[] }.
 * We avoid importing the full discriminated union and instead access fields
 * structurally so we never crash on a content-part variant we don't recognize.
 */
interface V3Message {
  role: string;
  content: unknown;
}

/** A single content part with a discriminant `type` field. */
interface ContentPart {
  type: string;
  text?: string;
  result?: unknown;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

function isContentPartArray(value: unknown): value is ContentPart[] {
  return (
    Array.isArray(value) && value.every((p) => typeof p === "object" && p !== null && "type" in p)
  );
}

/** Coerce a tool-result's `result` field (string | object | array) to text. */
function toolResultToText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (result != null) {
    try {
      return JSON.stringify(result);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Convert a V3 prompt message to an OpenAI-format message for the compress endpoint.
 * Returns undefined for messages with no compressible text content.
 */
function v3MessageToOpenAI(msg: V3Message): Record<string, unknown> | undefined {
  const openai: Record<string, unknown> = { role: msg.role };

  if (isContentPartArray(msg.content)) {
    const texts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          if (part.text) texts.push(part.text);
          break;
        case "tool-call":
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments:
                typeof part.args === "string" ? part.args : JSON.stringify(part.args ?? {}),
            },
          });
          break;
        case "tool-result": {
          const text = toolResultToText(part.result);
          if (text) texts.push(text);
          break;
        }
        default:
          break;
      }
    }

    // System/user messages → string content; assistant with tool_calls → tool_calls array.
    if (texts.length > 0) {
      openai.content = texts.join("\n");
    }
    if (toolCalls.length > 0) {
      openai.tool_calls = toolCalls;
      // OpenAI requires assistant tool-call messages to have null content sometimes;
      // the proxy only compresses text so we keep it optional.
      openai.content ??= null;
    }
  } else if (typeof msg.content === "string") {
    openai.content = msg.content;
  }

  // Only send messages that have content or tool_calls (skip pure-image messages).
  if (openai.content == null && openai.tool_calls == null) {
    return undefined;
  }

  return openai;
}

/**
 * Map compressed text back from OpenAI format into the V3 message structure.
 * We match by index (the proxy preserves message order) and replace only text
 * content parts, leaving images/tool-calls/reasoning untouched.
 */
function applyCompressedToV3(original: V3Message[], compressed: unknown[]): V3Message[] {
  // Build a list of (originalIndex, compressedIndex) pairs — the proxy may
  // have dropped messages with no compressible text, so we need to match
  // positionally by filtering both lists to the messages we actually sent.
  let compressedCursor = 0;
  const result: V3Message[] = [];

  for (const msg of original) {
    const wouldSend = v3MessageToOpenAI(msg) != null;
    if (!wouldSend) {
      // Message wasn't sent to the proxy — preserve it unchanged.
      result.push(msg);
      continue;
    }

    const compressedMsg = compressed[compressedCursor];
    compressedCursor++;

    if (compressedMsg == null || typeof compressedMsg !== "object") {
      result.push(msg);
      continue;
    }

    const newContent = (compressedMsg as Record<string, unknown>).content;
    const newContentStr = typeof newContent === "string" ? newContent : undefined;

    if (newContentStr == null) {
      result.push(msg);
      continue;
    }

    // Replace text in the first text-type content part; leave others unchanged.
    if (isContentPartArray(msg.content)) {
      let replaced = false;
      const updatedContent = msg.content.map((part) => {
        if (!replaced && part.type === "text") {
          replaced = true;
          return { ...part, text: newContentStr };
        }
        // For tool-result parts, the compressed text replaces the result string.
        if (!replaced && part.type === "tool-result" && typeof part.result === "string") {
          replaced = true;
          return { ...part, result: newContentStr };
        }
        return part;
      });
      result.push({ ...msg, content: updatedContent });
    } else {
      result.push({ ...msg, content: newContentStr });
    }
  }

  return result;
}

export interface HeadroomMiddlewareOptions {
  /** Base URL of the running headroom proxy (e.g. http://127.0.0.1:8787). */
  proxyBaseUrl: string;
  /** Model id for compression hints (sent as the `model` field). */
  modelId?: string;
}

/**
 * Create a LanguageModelV3Middleware that compresses the prompt via the headroom
 * proxy before each request. Always fails open — returns original params on any error.
 */
export function createHeadroomCompressMiddleware(
  options: HeadroomMiddlewareOptions
): LanguageModelV3Middleware {
  const client = new HeadroomClient(options.proxyBaseUrl);

  return {
    specificationVersion: "v3",

    transformParams: async ({
      params,
    }: {
      type: "generate" | "stream";
      params: LanguageModelV3CallOptions;
      model: LanguageModelV3;
    }): Promise<LanguageModelV3CallOptions> => {
      const prompt = params.prompt as unknown as V3Message[];
      if (!Array.isArray(prompt) || prompt.length === 0) {
        return params;
      }

      try {
        const openaiMessages = prompt
          .map(v3MessageToOpenAI)
          .filter((m): m is Record<string, unknown> => m != null);

        if (openaiMessages.length === 0) {
          return params;
        }

        const result = await client.compress(openaiMessages, options.modelId);

        if (!Array.isArray(result.messages) || result.messages.length === 0) {
          return params;
        }

        const compressedPrompt = applyCompressedToV3(
          prompt,
          result.messages
        ) as typeof params.prompt;

        return { ...params, prompt: compressedPrompt };
      } catch {
        // Fail-open: never block the request. The proxy may be down or slow;
        // the user's chat must continue with the original (uncompressed) prompt.
        return params;
      }
    },
  };
}
