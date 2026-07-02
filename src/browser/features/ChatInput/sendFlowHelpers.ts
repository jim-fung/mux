import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import type { FilePart, ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import type {
  AgentSkillReference,
  MuxMessageMetadata,
  ReviewNoteDataForDisplay,
} from "@/common/types/message";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import {
  getModelCapabilities,
  getModelCapabilitiesResolved,
} from "@/common/utils/ai/modelCapabilities";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { prepareCompactionMessage } from "@/browser/utils/chatCommands";
import { prepareUserMessageForSend, withAgentSkillRefs } from "@/common/types/message";
import { appendStagedAttachmentNotice, getStagedAttachments } from "./stagedAttachments";

// ----- Types -----

export interface PdfPreflightError {
  title: string;
  message: string;
}

export interface PdfPreflightResult {
  ok: boolean;
  error?: PdfPreflightError;
}

export interface CompactionRegenResult {
  actualMessageText: string;
  muxMetadata: MuxMessageMetadata | undefined;
  compactionOptions: Partial<SendMessageOptions>;
  appendStagedNoticeToUserMessage: boolean;
}

export interface WorkspaceSendOptionsInput {
  sendMessageOptions: SendMessageOptions;
  compactionOptions: Partial<SendMessageOptions>;
  modelOverride: string | undefined;
  thinkingOverride: string | undefined;
  isModelOneShot: boolean;
  goalInterventionPolicy: SendMessageOptions["goalInterventionPolicy"];
  queueDispatchMode: SendMessageOptions["queueDispatchMode"] | undefined;
  additionalSystemContextEnabled: boolean;
  additionalSystemContextContent: string;
  additionalSystemContextHydrated: boolean;
  additionalSystemInstructions: string | undefined;
  editMessageId: string | undefined;
  fileParts: FilePart[] | undefined;
  muxMetadata: MuxMessageMetadata | undefined;
}

// ----- Pure helpers -----

const PDF_MEDIA_TYPE = "application/pdf";

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (header.includes("base64")) {
    const encoded = dataUrl.slice(commaIndex + 1);
    return Math.floor((encoded.length * 3) / 4);
  }

  return dataUrl.length - commaIndex - 1;
}

/**
 * Validates that the selected model can accept PDF attachments and that each
 * PDF is within the model's size limit. Returns an error result the caller
 * can surface as a toast.
 */
export function preflightPdfAttachments(
  policyModel: string,
  attachments: ChatAttachment[],
  providersConfig: ProvidersConfigMap | null
): PdfPreflightResult {
  const pdfAttachments = attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { kind: "provider" }> =>
      attachment.kind === "provider" && getBaseMediaType(attachment.mediaType) === PDF_MEDIA_TYPE
  );

  if (pdfAttachments.length === 0) {
    return { ok: true };
  }

  const caps = getModelCapabilitiesResolved(policyModel, providersConfig);
  if (caps && !caps.supportsPdfInput) {
    const pdfCapableKnownModels = Object.values(KNOWN_MODELS)
      .map((m) => m.id)
      .filter((model) => getModelCapabilities(model)?.supportsPdfInput);
    const pdfCapableExamples = pdfCapableKnownModels.slice(0, 3);
    const examplesSuffix =
      pdfCapableKnownModels.length > pdfCapableExamples.length ? ", and others." : ".";

    return {
      ok: false,
      error: {
        title: "PDF not supported",
        message:
          `Model ${policyModel} does not support PDF input.` +
          (pdfCapableExamples.length > 0
            ? ` Try e.g.: ${pdfCapableExamples.join(", ")}${examplesSuffix}`
            : " Choose a model with PDF support."),
      },
    };
  }

  if (caps?.maxPdfSizeMb !== undefined) {
    const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
    for (const attachment of pdfAttachments) {
      const bytes = estimateBase64DataUrlBytes(attachment.url);
      if (bytes !== null && bytes > maxBytes) {
        const actualMb = (bytes / (1024 * 1024)).toFixed(1);
        return {
          ok: false,
          error: {
            title: "PDF too large",
            message: `${attachment.filename ?? "PDF"} is ${actualMb}MB, but ${policyModel} allows up to ${caps.maxPdfSizeMb}MB per PDF.`,
          },
        };
      }
    }
  }

  return { ok: true };
}

/**
 * When editing a message that starts with /compact, regenerate the actual
 * summarization request so the edit reflects the latest context.
 */
export function regenerateCompactionEditMessage(input: {
  messageText: string;
  api: RouterClient<AppRouter> | undefined;
  workspaceId: string;
  parsed: ParsedCommand;
  attachments: ChatAttachment[];
  reviews: ReviewNoteDataForDisplay[] | undefined;
  sendFileParts: FilePart[] | undefined;
  sendMessageOptions: SendMessageOptions;
  existingMetadata: MuxMessageMetadata | undefined;
}): CompactionRegenResult {
  const {
    messageText,
    api,
    workspaceId,
    parsed,
    attachments,
    reviews,
    sendFileParts,
    sendMessageOptions,
    existingMetadata,
  } = input;

  if (!parsed || parsed.type !== "compact") {
    return {
      actualMessageText: messageText,
      muxMetadata: existingMetadata,
      compactionOptions: {},
      appendStagedNoticeToUserMessage: true,
    };
  }

  const {
    messageText: regeneratedText,
    metadata,
    sendOptions,
  } = prepareCompactionMessage({
    api,
    workspaceId,
    maxOutputTokens: parsed.maxOutputTokens,
    followUpContent:
      parsed.continueMessage ||
      sendFileParts?.length ||
      reviews?.length ||
      getStagedAttachments(attachments).length
        ? {
            text: appendStagedAttachmentNotice(parsed.continueMessage ?? "", attachments),
            fileParts: sendFileParts,
            reviews,
          }
        : undefined,
    model: parsed.model,
    sendMessageOptions,
  });

  return {
    actualMessageText: regeneratedText,
    muxMetadata: metadata,
    compactionOptions: sendOptions,
    appendStagedNoticeToUserMessage: false,
  };
}

/**
 * Assembles the final SendMessageOptions for a workspace send by merging
 * base options, compaction options, and one-shot overrides.
 */
export function assembleWorkspaceSendOptions(input: WorkspaceSendOptionsInput): SendMessageOptions {
  const {
    sendMessageOptions,
    compactionOptions,
    modelOverride,
    thinkingOverride,
    isModelOneShot,
    goalInterventionPolicy,
    queueDispatchMode,
    additionalSystemContextEnabled,
    additionalSystemContextContent,
    additionalSystemContextHydrated,
    additionalSystemInstructions,
    editMessageId,
    fileParts,
    muxMetadata,
  } = input;

  return {
    ...sendMessageOptions,
    ...compactionOptions,
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(thinkingOverride ? { thinkingLevel: thinkingOverride } : {}),
    ...(isModelOneShot ? { skipAiSettingsPersistence: true } : {}),
    ...(goalInterventionPolicy ? { goalInterventionPolicy } : {}),
    ...(queueDispatchMode ? { queueDispatchMode } : {}),
    ...(additionalSystemContextHydrated
      ? {
          additionalSystemContext: additionalSystemContextEnabled
            ? additionalSystemContextContent
            : "",
        }
      : {}),
    additionalSystemInstructions,
    editMessageId,
    muxMetadata,
    // fileParts is accepted by the sendMessage endpoint but not in the
    // zod-inferred SendMessageOptions type. Spread to avoid type error.
    ...(fileParts ? { fileParts } : {}),
  } as SendMessageOptions;
}

/**
 * Prepares the final user message text + metadata for sending.
 * Handles staged attachment notices, skill refs, and review metadata.
 */
export function prepareWorkspaceMessageForSend(input: {
  actualMessageText: string;
  attachments: ChatAttachment[];
  appendStagedNotice: boolean;
  reviews: ReviewNoteDataForDisplay[] | undefined;
  existingMetadata: MuxMessageMetadata | undefined;
  combinedSkillRefs: AgentSkillReference[];
}): { finalText: string; metadata: MuxMessageMetadata | undefined } {
  const {
    actualMessageText,
    attachments,
    appendStagedNotice,
    reviews,
    existingMetadata,
    combinedSkillRefs,
  } = input;

  let muxMetadata = existingMetadata;
  if (combinedSkillRefs.length > 0) {
    muxMetadata = withAgentSkillRefs(muxMetadata, combinedSkillRefs);
  }

  const userMessageText = appendStagedNotice
    ? appendStagedAttachmentNotice(actualMessageText, attachments)
    : actualMessageText;

  const { finalText, metadata: reviewMetadata } = prepareUserMessageForSend(
    { text: userMessageText, reviews },
    muxMetadata
  );

  return { finalText, metadata: reviewMetadata };
}
