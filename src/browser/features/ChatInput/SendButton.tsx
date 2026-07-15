import React, { useEffect, useRef } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { SEND_DISPATCH_MODES } from "./sendDispatchModes";
import type { QueueDispatchMode } from "./types";
import type { EditingMessageState } from "@/browser/utils/chatEditing";

export interface SendButtonProps {
  canSend: boolean;
  canChooseDispatchMode: boolean;
  onSend: (overrides?: { queueDispatchMode?: QueueDispatchMode }) => void;
  variant: "workspace" | "creation";
  editingMessageForUi: EditingMessageState | undefined;
  runningGoalActive: boolean;
}

/**
 * Send button with right-click / long-press dispatch mode menu.
 *
 * Owns the context-menu positioning hook and the outside-click / escape dismiss
 * effects so the parent only needs to provide `onSend`.
 */
export const SendButton: React.FC<SendButtonProps> = (props) => {
  const {
    canSend,
    canChooseDispatchMode,
    onSend,
    variant,
    editingMessageForUi,
    runningGoalActive,
  } = props;

  const sendModeMenuContainerRef = useRef<HTMLDivElement>(null);
  const sendModeMenu = useContextMenuPosition({
    longPress: true,
    canOpen: () => canChooseDispatchMode,
  });
  const {
    isOpen: isSendModeMenuOpen,
    onContextMenu: openSendModeMenuFromContext,
    touchHandlers: sendModeMenuTouchHandlers,
    suppressClickIfLongPress: suppressSendClickIfLongPress,
    close: closeSendModeMenu,
  } = sendModeMenu;

  // Close the menu when dispatch modes are no longer available (e.g. send in flight).
  useEffect(() => {
    if (canChooseDispatchMode) {
      return;
    }
    closeSendModeMenu();
  }, [canChooseDispatchMode, closeSendModeMenu]);

  // Dismiss the open menu on outside-click or Escape.
  useEffect(() => {
    if (!isSendModeMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (sendModeMenuContainerRef.current?.contains(event.target as Node)) {
        return;
      }
      closeSendModeMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      // Mark Escape as handled so global interrupt listeners do not cancel the stream
      // when users are only dismissing this inline send-mode menu.
      event.preventDefault();
      event.stopPropagation();
      closeSendModeMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeSendModeMenu, isSendModeMenuOpen]);

  return (
    <div ref={sendModeMenuContainerRef} className="relative -ml-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={() => {
              if (suppressSendClickIfLongPress()) {
                return;
              }
              onSend();
            }}
            onContextMenu={openSendModeMenuFromContext}
            onTouchStart={sendModeMenuTouchHandlers.onTouchStart}
            onTouchEnd={sendModeMenuTouchHandlers.onTouchEnd}
            onTouchMove={sendModeMenuTouchHandlers.onTouchMove}
            onTouchCancel={sendModeMenuTouchHandlers.onTouchEnd}
            disabled={!canSend}
            aria-label="Send message"
            aria-expanded={canChooseDispatchMode ? isSendModeMenuOpen : undefined}
            aria-haspopup={canChooseDispatchMode ? "menu" : undefined}
            size="xs"
            variant="ghost"
            className="text-muted hover:text-foreground hover:bg-hover inline-flex items-center justify-center rounded-sm px-1.5 py-0.5 font-medium transition-colors duration-200 disabled:opacity-50 [@media(hover:none)_and_(pointer:coarse)]:h-9 [@media(hover:none)_and_(pointer:coarse)]:w-11 [@media(hover:none)_and_(pointer:coarse)]:px-0 [@media(hover:none)_and_(pointer:coarse)]:py-0 [@media(hover:none)_and_(pointer:coarse)]:text-sm"
          >
            <SendHorizontal
              className="h-3.5 w-3.5 [@media(hover:none)_and_(pointer:coarse)]:h-4 [@media(hover:none)_and_(pointer:coarse)]:w-4"
              strokeWidth={2.5}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <strong>Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})</strong>
          {variant === "workspace" && (
            <>
              <br />
              <br />
              <strong>Right-click or long-press for advanced send modes:</strong>
              {runningGoalActive && !editingMessageForUi && (
                <>
                  <br />
                  Manual sends pause the current goal; use Resume to continue it.
                </>
              )}
              {SEND_DISPATCH_MODES.map((entry) => (
                <React.Fragment key={entry.mode}>
                  <br />
                  {entry.label}: <kbd>{formatKeybind(entry.keybind)}</kbd>
                </React.Fragment>
              ))}
            </>
          )}
        </TooltipContent>
      </Tooltip>

      {canChooseDispatchMode && isSendModeMenuOpen && (
        <div className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 min-w-[12.5rem] rounded-md border p-1.5 shadow-md">
          {SEND_DISPATCH_MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1 text-left text-xs"
              onClick={() => {
                closeSendModeMenu();
                onSend(entry.mode === "tool-end" ? undefined : { queueDispatchMode: entry.mode });
              }}
            >
              <span className="whitespace-nowrap">{entry.label}</span>
              <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-1.5 py-px font-mono text-[10px] whitespace-nowrap">
                {formatKeybind(entry.keybind)}
              </kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
