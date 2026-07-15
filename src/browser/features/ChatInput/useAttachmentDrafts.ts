import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import {
  extractAttachmentsFromClipboard,
  extractAttachmentsFromDrop,
  processAttachmentFiles,
} from "@/browser/utils/attachmentsHandling";
import {
  estimatePersistedChatAttachmentsChars,
  readPersistedChatAttachments,
} from "./draftAttachmentsStorage";
import type { Toast } from "./ChatInputToast";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { EditingMessageState } from "@/browser/utils/chatEditing";

const MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS = 4_000_000;

// Shared so the three "blocked while editing a message" attachment guards surface identical copy
// and can't drift if one is reworded.
const EDIT_MODE_ATTACHMENT_ERROR_MESSAGE = "Attachments cannot be added while editing a message.";

export interface AttachmentDraftsConfig {
  storageKeys: { attachmentsKey: string };
  pushToast: (nextToast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
  variant: "workspace" | "creation";
  workspaceId: string | null;
  api: APIClient | null | undefined;
  editingMessageForUi: EditingMessageState | undefined;
}

export interface AttachmentDraftsReturn {
  attachments: ChatAttachment[];
  setAttachments: (
    value: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])
  ) => void;
  processingAttachmentCount: number;
  draftReviews: ReviewNoteDataForDisplay[] | null;
  setDraftReviews: React.Dispatch<React.SetStateAction<ReviewNoteDataForDisplay[] | null>>;
  getDraftReviewId: (review: ReviewNoteDataForDisplay) => string;
  removeDraftReview: (reviewId: string) => void;
  updateDraftReviewNote: (reviewId: string, newNote: string) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  handleDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  handleRemoveAttachment: (id: string) => void;
  handleAttachFiles: (files: File[]) => void;
}

export function useAttachmentDrafts(config: AttachmentDraftsConfig): AttachmentDraftsReturn {
  const { storageKeys, pushToast, variant, workspaceId, api, editingMessageForUi } = config;

  const attachmentDraftTooLargeToastKeyRef = useRef<string | null>(null);

  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() => {
    return readPersistedChatAttachments(storageKeys.attachmentsKey);
  });
  const [processingAttachmentCount, setProcessingAttachmentCount] = useState(0);
  // Reviews restored from edits/queued drafts override attached review state while active.
  const [draftReviews, setDraftReviews] = useState<ReviewNoteDataForDisplay[] | null>(null);

  const persistAttachments = useCallback(
    (nextAttachments: ChatAttachment[]) => {
      if (nextAttachments.length === 0) {
        attachmentDraftTooLargeToastKeyRef.current = null;
        updatePersistedState<ChatAttachment[] | undefined>(storageKeys.attachmentsKey, undefined);
        return;
      }

      const estimatedChars = estimatePersistedChatAttachmentsChars(nextAttachments);
      if (estimatedChars > MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS) {
        // Clear persisted value to avoid restoring stale attachments on restart.
        updatePersistedState<ChatAttachment[] | undefined>(storageKeys.attachmentsKey, undefined);

        if (attachmentDraftTooLargeToastKeyRef.current !== storageKeys.attachmentsKey) {
          attachmentDraftTooLargeToastKeyRef.current = storageKeys.attachmentsKey;
          pushToast({
            type: "error",
            message:
              "This draft attachment is too large to save. It will be lost when you switch workspaces or restart.",
            duration: 5000,
          });
        }
        return;
      }

      attachmentDraftTooLargeToastKeyRef.current = null;
      updatePersistedState<ChatAttachment[] | undefined>(
        storageKeys.attachmentsKey,
        nextAttachments
      );
    },
    [storageKeys.attachmentsKey, pushToast]
  );

  // Keep attachment drafts in sync when the storage scope changes (e.g. switching creation projects).
  useEffect(() => {
    attachmentDraftTooLargeToastKeyRef.current = null;
    setAttachmentsState(readPersistedChatAttachments(storageKeys.attachmentsKey));
  }, [storageKeys.attachmentsKey]);

  const setAttachments = useCallback(
    (value: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      setAttachmentsState((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        persistAttachments(next);
        return next;
      });
    },
    [persistAttachments]
  );

  // draftReviews takes precedence when restoring or editing message drafts.
  const draftReviewIdsByValueRef = useRef(new WeakMap<ReviewNoteDataForDisplay, string>());
  const nextDraftReviewIdRef = useRef(0);
  const isDraftReviewData = (value: unknown): value is ReviewNoteDataForDisplay =>
    typeof value === "object" && value !== null;
  const getDraftReviewId = (review: ReviewNoteDataForDisplay): string => {
    const existingId = draftReviewIdsByValueRef.current.get(review);
    if (existingId) return existingId;
    const newId = `draft-review-${nextDraftReviewIdRef.current++}`;
    draftReviewIdsByValueRef.current.set(review, newId);
    return newId;
  };

  const withDraftReview = (
    reviewId: string,
    update: (reviews: ReviewNoteDataForDisplay[], reviewIndex: number) => ReviewNoteDataForDisplay[]
  ) =>
    setDraftReviews((prev) => {
      if (prev === null) return prev;
      const reviewIndex = prev.findIndex(
        (review) => isDraftReviewData(review) && getDraftReviewId(review) === reviewId
      );
      return reviewIndex === -1 ? prev : update(prev, reviewIndex);
    });

  const removeDraftReview = (reviewId: string) =>
    withDraftReview(reviewId, (prev, reviewIndex) =>
      prev.filter((_, index) => index !== reviewIndex)
    );

  const updateDraftReviewNote = (reviewId: string, newNote: string) =>
    withDraftReview(reviewId, (prev, reviewIndex) => {
      const review = prev[reviewIndex];
      if (!review || review.userNote === newNote) return prev;
      const next = [...prev];
      const updatedReview = { ...review, userNote: newNote };
      draftReviewIdsByValueRef.current.set(updatedReview, reviewId);
      next[reviewIndex] = updatedReview;
      return next;
    });

  const showResizeToast = useCallback(
    (nextAttachments: ChatAttachment[]) => {
      const resized = nextAttachments.filter(
        (attachment): attachment is Extract<ChatAttachment, { kind: "provider" }> =>
          attachment.kind === "provider" && attachment.resizeInfo != null
      );
      if (resized.length === 0) {
        return;
      }

      const firstResizeInfo = resized[0].resizeInfo;
      if (!firstResizeInfo) {
        return;
      }

      // Tell users when we auto-resize so the attachment dimensions are never surprising.
      const message =
        resized.length === 1
          ? `Image resized from ${firstResizeInfo.originalWidth}×${firstResizeInfo.originalHeight} to ${firstResizeInfo.newWidth}×${firstResizeInfo.newHeight}`
          : `${resized.length} images resized to fit provider limits`;

      pushToast({ type: "info", message });
    },
    [pushToast]
  );

  const processAttachmentFilesForComposer = useCallback(
    (files: File[]): Promise<ChatAttachment[]> => {
      setProcessingAttachmentCount((count) => count + 1);
      return processAttachmentFiles(files, {
        stageAttachment:
          variant === "workspace"
            ? async (file, dataBase64) => {
                if (!api) {
                  throw new Error("Not connected to server");
                }
                if (workspaceId == null) {
                  throw new Error("ZIP attachments can be added after opening a workspace.");
                }
                const result = await api.workspace.stageAttachment({
                  workspaceId,
                  filename: file.name,
                  mediaType: file.type || null,
                  sizeBytes: file.size,
                  dataBase64,
                });
                if (!result.success) {
                  throw new Error(result.error);
                }
                return result.data;
              }
            : undefined,
      }).finally(() => {
        setProcessingAttachmentCount((count) => Math.max(0, count - 1));
      });
    },
    [api, variant, workspaceId]
  );

  // Handle paste events to extract attachments
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const attachmentFiles = extractAttachmentsFromClipboard(items);
      if (attachmentFiles.length === 0) return;

      // When editing an existing message, we only allow changing the text.
      // Don't preventDefault here so any clipboard text can still paste normally.
      if (editingMessageForUi) {
        pushToast({
          type: "error",
          message: EDIT_MODE_ATTACHMENT_ERROR_MESSAGE,
        });
        return;
      }

      e.preventDefault(); // Prevent default paste behavior for attachments

      processAttachmentFilesForComposer(attachmentFiles)
        .then((nextAttachments) => {
          setAttachments((prev) => [...prev, ...nextAttachments]);
          showResizeToast(nextAttachments);
        })
        .catch((error) => {
          console.error("Failed to process pasted attachment:", error);
          pushToast({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process attachment",
          });
        });
    },
    [
      editingMessageForUi,
      processAttachmentFilesForComposer,
      pushToast,
      setAttachments,
      showResizeToast,
    ]
  );

  // Handle removing an attachment
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((img) => img.id !== id));
    },
    [setAttachments]
  );

  // Handle files selected via the attach file picker.
  // Process each file individually so unsupported files (e.g. user switched the
  // native picker to "All files") don't reject the entire batch — valid files
  // still get attached and only failures are toasted.
  const handleAttachFiles = (files: File[]) => {
    if (editingMessageForUi) {
      pushToast({
        type: "error",
        message: EDIT_MODE_ATTACHMENT_ERROR_MESSAGE,
      });
      return;
    }
    const results = files.map((file) =>
      processAttachmentFilesForComposer([file]).then(
        (attachments) => ({ ok: true as const, attachments }),
        (error: unknown) => ({ ok: false as const, error })
      )
    );
    void Promise.all(results).then((outcomes) => {
      const successes = outcomes.flatMap((o) => (o.ok ? o.attachments : []));
      if (successes.length > 0) {
        setAttachments((prev) => [...prev, ...successes]);
        showResizeToast(successes);
      }
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          const msg =
            outcome.error instanceof Error ? outcome.error.message : "Failed to process attachment";
          console.error("Failed to process attached file:", outcome.error);
          pushToast({ type: "error", message: msg });
        }
      }
    });
  };

  // Handle drag over to allow drop
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      // Check if drag contains files
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = editingMessageForUi ? "none" : "copy";
      }
    },
    [editingMessageForUi]
  );

  // Handle drop to extract attachments
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();

      const attachmentFiles = extractAttachmentsFromDrop(e.dataTransfer);
      if (attachmentFiles.length === 0) return;

      if (editingMessageForUi) {
        pushToast({
          type: "error",
          message: EDIT_MODE_ATTACHMENT_ERROR_MESSAGE,
        });
        return;
      }

      processAttachmentFilesForComposer(attachmentFiles)
        .then((nextAttachments) => {
          setAttachments((prev) => [...prev, ...nextAttachments]);
          showResizeToast(nextAttachments);
        })
        .catch((error) => {
          console.error("Failed to process dropped attachment:", error);
          pushToast({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process attachment",
          });
        });
    },
    [
      editingMessageForUi,
      processAttachmentFilesForComposer,
      pushToast,
      setAttachments,
      showResizeToast,
    ]
  );

  return {
    attachments,
    setAttachments,
    processingAttachmentCount,
    draftReviews,
    setDraftReviews,
    getDraftReviewId,
    removeDraftReview,
    updateDraftReviewNote,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleRemoveAttachment,
    handleAttachFiles,
  };
}
