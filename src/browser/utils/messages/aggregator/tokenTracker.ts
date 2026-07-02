import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { UsageDeltaEvent } from "@/common/types/stream";
import { createDeltaStorage, type DeltaRecordStorage } from "../StreamingTPSCalculator";

interface ActiveStreamUsageEntry {
  step: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
  cumulative: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
}

/**
 * Tracks per-message token deltas (for TPS calculation) and per-step usage
 * events (for context-window and cost display).
 *
 * Extracted from StreamingMessageAggregator as part of H7.
 */
export class TokenTracker {
  private deltaHistory = new Map<string, DeltaRecordStorage>();
  private activeStreamUsage = new Map<string, ActiveStreamUsageEntry>();

  /** Track a delta for token counting and TPS calculation. */
  trackDelta(
    messageId: string,
    tokens: number,
    timestamp: number,
    type: "text" | "reasoning" | "tool-args"
  ): void {
    let storage = this.deltaHistory.get(messageId);
    if (!storage) {
      storage = createDeltaStorage();
      this.deltaHistory.set(messageId, storage);
    }
    storage.addDelta({ tokens, timestamp, type });
  }

  /** Get streaming token count (sum of all deltas). */
  getStreamingTokenCount(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.getTokenCount() : 0;
  }

  /** Get tokens-per-second rate (10-second trailing window). */
  getStreamingTPS(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.calculateTPS(Date.now()) : 0;
  }

  /** Clear delta history and usage for a message. */
  clearTokenState(messageId: string): void {
    this.deltaHistory.delete(messageId);
    this.activeStreamUsage.delete(messageId);
  }

  /** Handle usage-delta event: update usage tracking for active stream. */
  handleUsageDelta(data: UsageDeltaEvent): void {
    this.activeStreamUsage.set(data.messageId, {
      step: { usage: data.usage, providerMetadata: data.providerMetadata },
      cumulative: {
        usage: data.cumulativeUsage,
        providerMetadata: data.cumulativeProviderMetadata,
      },
    });
  }

  /** Get active stream usage for context window display (last step's inputTokens = context size). */
  getActiveStreamUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.step.usage;
  }

  /** Get step provider metadata for context window cache display. */
  getActiveStreamStepProviderMetadata(messageId: string): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.step.providerMetadata;
  }

  /** Get active stream cumulative usage for cost display (sum of all steps). */
  getActiveStreamCumulativeUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.usage;
  }

  /** Get cumulative provider metadata for cost display (with accumulated cache creation tokens). */
  getActiveStreamCumulativeProviderMetadata(
    messageId: string
  ): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.providerMetadata;
  }

  /** Clear all state (used during replay reset). */
  clearAll(): void {
    this.deltaHistory.clear();
    this.activeStreamUsage.clear();
  }
}
