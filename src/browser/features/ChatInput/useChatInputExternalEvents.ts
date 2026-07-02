import { useEffect, type RefObject } from "react";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { ModelSelectorRef } from "@/browser/components/ModelSelector/ModelSelector";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { FilePart } from "@/common/orpc/types";
import type { EditingMessageState, PendingUserMessage } from "@/browser/utils/chatEditing";
import { buildPendingFromRestoredInput } from "@/browser/utils/chatEditing";

export interface ExternalEventsConfig {
  workspaceIdForComposerClear: string | null;
  onDetachAllReviewsForComposerClear: (() => void) | undefined;
  setInput: (value: string | ((prev: string) => string)) => void;
  setAttachments: (value: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => void;
  setDraftReviews: React.Dispatch<React.SetStateAction<ReviewNoteDataForDisplay[] | null>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  modelSelectorRef: RefObject<ModelSelectorRef | null>;
  editingMessageForUi: EditingMessageState | undefined;
  appendText: (text: string) => void;
  restoreText: (text: string) => void;
  restoreDraft: (pending: PendingUserMessage) => void;
  applyDraftFromPending: (pending: PendingUserMessage, attachmentKeyPrefix: string) => void;
  getDraft: () => { text: string; attachments: ChatAttachment[] };
}

/**
 * Subscribes to window events that manipulate the chat composer externally:
 * UPDATE_CHAT_INPUT (insert/replace text+attachments), CLEAR_CHAT_COMPOSER,
 * and OPEN_MODEL_SELECTOR.
 */
export function useChatInputExternalEvents(config: ExternalEventsConfig): void {
  const {
    workspaceIdForComposerClear,
    onDetachAllReviewsForComposerClear,
    setInput,
    setAttachments,
    setDraftReviews,
    inputRef,
    modelSelectorRef,
    editingMessageForUi,
    appendText,
    restoreText,
    restoreDraft,
    applyDraftFromPending,
    getDraft,
  } = config;

  // Allow external components (e.g., CommandPalette, Queued message edits) to insert text
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{
        text: string;
        mode?: "append" | "replace";
        fileParts?: FilePart[];
        reviews?: ReviewNoteDataForDisplay[];
      }>;

      const { text, mode = "append", fileParts, reviews } = customEvent.detail;
      const restoredIdPrefix = `restored-${Date.now()}`;
      const restoredPending = buildPendingFromRestoredInput({
        content: text,
        fileParts: fileParts ?? [],
        reviews: reviews ?? [],
        idPrefix: restoredIdPrefix,
      });
      const hasFileParts = restoredPending.fileParts.length > 0;
      const hasStagedAttachments = restoredPending.stagedAttachments.length > 0;
      const hasReviews = restoredPending.reviews.length > 0;

      if (mode === "replace") {
        if (editingMessageForUi) {
          return;
        }
        if (hasFileParts || hasStagedAttachments || hasReviews) {
          restoreDraft(restoredPending);
        } else {
          restoreText(restoredPending.content);
        }
      } else if (hasFileParts || hasStagedAttachments || hasReviews) {
        const currentText = getDraft().text;
        const separator = currentText.trim() ? "\n\n" : "";
        applyDraftFromPending(
          {
            ...restoredPending,
            content: currentText + separator + restoredPending.content,
          },
          restoredIdPrefix
        );
      } else {
        appendText(restoredPending.content);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, handler as EventListener);
  }, [
    appendText,
    restoreText,
    restoreDraft,
    applyDraftFromPending,
    getDraft,
    editingMessageForUi,
  ]);

  useEffect(() => {
    const handler = (event: CustomEvent<{ workspaceId: string }>) => {
      if (workspaceIdForComposerClear !== event.detail.workspaceId) {
        return;
      }

      setInput("");
      setAttachments([]);
      setDraftReviews(null);
      onDetachAllReviewsForComposerClear?.();
      if (inputRef.current) {
        inputRef.current.style.height = "";
      }
    };

    window.addEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, handler as EventListener);
  }, [
    onDetachAllReviewsForComposerClear,
    setAttachments,
    setInput,
    setDraftReviews,
    workspaceIdForComposerClear,
    inputRef,
  ]);

  // Allow external components to open the Model Selector
  useEffect(() => {
    const handler = () => {
      modelSelectorRef.current?.open();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR, handler as EventListener);
  }, [modelSelectorRef]);
}
