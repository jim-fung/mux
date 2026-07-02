import { useEffect } from "react";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { Toast } from "./ChatInputToast";

export interface ChatInputToastsConfig {
  variant: "workspace" | "creation";
  workspaceId: string | null;
  pushToast: (nextToast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
  voiceInput: {
    shouldShowUI: boolean;
    isAvailable: boolean;
    toggle: () => void;
  };
  voiceInputUnavailableMessage: string;
}

/**
 * Subscribes to window events that surface toasts (thinking-level change,
 * goal child-budget warning, analytics rebuild) and toggles voice input.
 */
export function useChatInputToasts(config: ChatInputToastsConfig): void {
  const { variant, workspaceId, pushToast, voiceInput, voiceInputUnavailableMessage } = config;

  // Show toast when thinking level is changed via command palette (workspace only)
  useEffect(() => {
    if (variant !== "workspace") return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; level: ThinkingLevel }>).detail;
      if (detail?.workspaceId !== workspaceId || !detail.level) {
        return;
      }

      const level = detail.level;
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "Off — fastest responses",
        low: "Low — adds light reasoning",
        medium: "Medium — balanced reasoning",
        high: "High — maximum reasoning depth",
        xhigh: "Max — deepest possible reasoning",
        max: "Max — deepest possible reasoning",
      };

      pushToast({
        type: "success",
        message: `Thinking effort set to ${levelDescriptions[level]}`,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, handler as EventListener);
  }, [variant, workspaceId, pushToast]);

  // Show the backend's one-shot child-budget warning on the matching parent workspace.
  useEffect(() => {
    if (variant !== "workspace") return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; message: string }>).detail;
      if (detail?.workspaceId !== workspaceId || !detail.message) {
        return;
      }

      pushToast({ type: "error", message: detail.message });
    };

    window.addEventListener(CUSTOM_EVENTS.GOAL_CHILD_BUDGET_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.GOAL_CHILD_BUDGET_TOAST, handler as EventListener);
  }, [variant, workspaceId, pushToast]);

  // Show toast feedback for analytics rebuild command palette action.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ type: "success" | "error"; message: string; title?: string }>
      ).detail;

      if (!detail || (detail.type !== "success" && detail.type !== "error")) {
        return;
      }

      pushToast({
        type: detail.type,
        title: detail.title,
        message: detail.message,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, handler as EventListener);
  }, [pushToast]);

  // Voice input: command palette toggle
  useEffect(() => {
    if (!voiceInput.shouldShowUI) return;

    const handleToggle = () => {
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
    };

    window.addEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT, handleToggle as EventListener);
    };
  }, [voiceInput, pushToast, voiceInputUnavailableMessage]);
}
