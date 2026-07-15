import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  CommandSuggestions,
  COMMAND_SUGGESTION_KEYS,
  FILE_SUGGESTION_KEYS,
} from "@/browser/features/ChatInput/CommandSuggestions";
import type { Toast } from "@/browser/features/ChatInput/ChatInputToast";
import { ConnectionStatusToast } from "@/browser/components/ConnectionStatusToast/ConnectionStatusToast";
import { ChatInputToast } from "@/browser/features/ChatInput/ChatInputToast";
import type { SendMessageError } from "@/common/types/errors";
import { createErrorToast } from "@/browser/features/ChatInput/ChatInputToasts";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import { usePersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import { ThinkingSliderComponent } from "@/browser/components/ThinkingSlider/ThinkingSlider";
import {
  getAllowedRuntimeModesForUi,
  isParsedRuntimeAllowedByPolicy,
} from "@/browser/utils/policyUi";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import {
  useAdditionalSystemContextHydrated,
  useAdditionalSystemContextSnapshot,
} from "@/browser/utils/additionalSystemContextStore";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import {
  getModelKey,
  getInputKey,
  getInputAttachmentsKey,
  VIM_ENABLED_KEY,
  RUNTIME_ENABLEMENT_KEY,
  getProjectScopeId,
  getPendingScopeId,
  getDraftScopeId,
  getPendingWorkspaceSendErrorKey,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";
import { processSlashCommand, type SlashCommandContext } from "@/browser/utils/chatCommands";
import {
  addWorkflowRunCardMessageForRun,
  getWorkflowRunCardProjection,
} from "@/browser/utils/workflowRunMessages";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  convertSymbolCommandAtCursor,
  convertTerminatedSymbolCommand,
} from "@/browser/features/ChatInput/symbolShortcuts";
import { resolveWorkspaceCreationScope } from "@/common/utils/subProjects";
import { AgentModePicker } from "@/browser/components/AgentModePicker/AgentModePicker";
import { ContextUsageIndicatorButton } from "@/browser/components/ContextUsageIndicatorButton/ContextUsageIndicatorButton";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceStoreRaw,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { getPlaceholderTip } from "./placeholderTips";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { useIdleCompactionHours } from "@/browser/hooks/useIdleCompactionHours";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import {
  matchesKeybind,
  formatKeybind,
  KEYBINDS,
  isEditableElement,
} from "@/browser/utils/ui/keybinds";
import { isGoalRunning } from "@/common/types/goal";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  ModelSelector,
  type ModelSelectorRef,
} from "@/browser/components/ModelSelector/ModelSelector";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { AttachFileButton } from "./AttachFileButton";
import { VimTextArea } from "@/browser/components/VimTextArea/VimTextArea";
import { ChatAttachments, type ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import { type PendingUserMessage } from "@/browser/utils/chatEditing";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { DEFAULT_RUNTIME_ENABLEMENT, normalizeRuntimeEnablement } from "@/common/types/runtime";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import {
  type MuxMessageMetadata,
  type ReviewNoteDataForDisplay,
  withAgentSkillRefs,
} from "@/common/types/message";
import type { Review } from "@/common/types/review";
import { MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { trackCommandUsed } from "@/common/telemetry";
import type { SendMessageOptions } from "@/common/orpc/types";

import { CreationCenterContent } from "./CreationCenterContent";
import { cn } from "@/common/lib/utils";
import type {
  ChatInputProps,
  ChatInputAPI,
  GoalInterventionPolicy,
  QueueDispatchMode,
} from "./types";
import { CreationControls } from "./CreationControls";
import { SendButton } from "./SendButton";
import { useChatInputToasts } from "./useChatInputToasts";
import { useChatInputExternalEvents } from "./useChatInputExternalEvents";
import { useWorkspaceModelSelection } from "./useWorkspaceModelSelection";
import { CodexOauthWarningBanner } from "./CodexOauthWarningBanner";
import { useCreationWorkspace } from "./useCreationWorkspace";
import { useCoderWorkspace } from "@/browser/hooks/useCoderWorkspace";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { usePowerMode } from "@/browser/contexts/PowerModeContext";
import { useVoiceInput } from "@/browser/hooks/useVoiceInput";
import { VoiceInputButton } from "./VoiceInputButton";
import { RecordingOverlay } from "./RecordingOverlay";
import { AttachedReviewsPanel } from "./AttachedReviewsPanel";
import {
  buildSkillInvocationMetadata,
  hasProjectScopedSkillRef,
  parseCommandWithSkillInvocation,
  resolveInlineSkillRefsForSend,
  validateCreationRuntime,
  filePartsToChatAttachments,
  type SkillResolutionTarget,
} from "./utils";
import {
  preflightPdfAttachments,
  regenerateCompactionEditMessage,
  assembleWorkspaceSendOptions,
  prepareWorkspaceMessageForSend,
} from "./sendFlowHelpers";
import { useSuggestionMenus } from "./useSuggestionMenus";
import { useAttachmentDrafts } from "./useAttachmentDrafts";
import { appendStagedAttachmentNotice, getStagedAttachments } from "./stagedAttachments";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export type { ChatInputProps, ChatInputAPI };

interface SendOverrides {
  queueDispatchMode?: QueueDispatchMode;
  goalInterventionPolicy?: GoalInterventionPolicy;
}

interface InternalSendOverrides extends SendOverrides {
  skipBoundaryEditConfirmation?: boolean;
}

const ChatInputInner: React.FC<ChatInputProps> = (props) => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const runtimePolicy = useMemo(
    () => getAllowedRuntimeModesForUi(effectivePolicy),
    [effectivePolicy]
  );
  const { variant } = props;
  const { userProjects } = useProjectContext();
  const creationScope =
    variant === "creation"
      ? resolveWorkspaceCreationScope(props.projectPath, userProjects, props.pendingSubProjectPath)
      : null;
  const creationParentProjectPath = creationScope?.projectPath ?? "";
  const creationSubProjectPath = creationScope?.subProjectPath ?? undefined;
  const creationProject =
    variant === "creation" ? userProjects.get(creationParentProjectPath) : undefined;
  const [thinkingLevel] = useThinkingLevel();
  const dynamicWorkflowsExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const workspaceHeartbeatsExperimentEnabled = useExperimentValue(
    EXPERIMENT_IDS.WORKSPACE_HEARTBEATS
  );
  const memoryExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const memoryConsolidationExperimentEnabled = useExperimentValue(
    EXPERIMENT_IDS.MEMORY_CONSOLIDATION
  );
  const atMentionProjectPath = variant === "creation" ? props.projectPath : null;
  const asyncCommandScopeRef = useRef<{ variant: typeof variant; workspaceId: string | null }>({
    variant,
    workspaceId: variant === "workspace" ? props.workspaceId : null,
  });
  const asyncCommandTokenRef = useRef(0);
  const workspaceId = variant === "workspace" ? props.workspaceId : null;

  useEffect(() => {
    asyncCommandScopeRef.current = { variant, workspaceId };
  }, [variant, workspaceId]);

  const store = useWorkspaceStoreRaw();
  const workspaceSidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const workspaceGoal = workspaceSidebarState?.goal ?? null;

  // Extract workspace-specific props with defaults
  const disabled = props.disabled ?? false;
  const editingMessage = variant === "workspace" ? props.editingMessage : undefined;
  const [pendingBoundaryEditConfirmation, setPendingBoundaryEditConfirmation] =
    useState<SendOverrides | null>(null);
  // Hide edit-mode chrome as soon as an edit send starts so the input doesn't sit blank
  // while the backend acknowledges the edit and begins the replacement stream.
  const [optimisticallyDismissedEditId, setOptimisticallyDismissedEditId] = useState<string | null>(
    null
  );
  const editingMessageForUi =
    editingMessage?.id === optimisticallyDismissedEditId ? undefined : editingMessage;
  const isTranscriptCaughtUp =
    variant === "workspace" ? (props.isTranscriptCaughtUp ?? false) : false;
  const isStreamStarting = variant === "workspace" ? (props.isStreamStarting ?? false) : false;
  const isCompacting = variant === "workspace" ? (props.isCompacting ?? false) : false;
  const [isMobileTouch, setIsMobileTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileTouchMediaQuery = window.matchMedia("(max-width: 768px) and (pointer: coarse)");
    const handleMobileTouchChange = () => {
      setIsMobileTouch(mobileTouchMediaQuery.matches);
    };

    handleMobileTouchChange();
    mobileTouchMediaQuery.addEventListener("change", handleMobileTouchChange);
    return () => {
      mobileTouchMediaQuery.removeEventListener("change", handleMobileTouchChange);
    };
  }, []);
  useEffect(() => {
    if (
      optimisticallyDismissedEditId != null &&
      editingMessage?.id !== optimisticallyDismissedEditId
    ) {
      setOptimisticallyDismissedEditId(null);
    }
  }, [editingMessage?.id, optimisticallyDismissedEditId]);
  // runtimeType for telemetry - defaults to "worktree" if not provided
  const runtimeType = variant === "workspace" ? (props.runtimeType ?? "worktree") : "worktree";

  // Callback for model changes (both variants support this)
  const onModelChange = props.onModelChange;

  // Storage keys differ by variant
  const storageKeys = (() => {
    if (variant === "creation") {
      const pendingScopeId =
        typeof props.pendingDraftId === "string" && props.pendingDraftId.trim().length > 0
          ? getDraftScopeId(creationParentProjectPath, props.pendingDraftId)
          : getPendingScopeId(creationParentProjectPath);
      return {
        inputKey: getInputKey(pendingScopeId),
        attachmentsKey: getInputAttachmentsKey(pendingScopeId),
        modelKey: getModelKey(getProjectScopeId(creationParentProjectPath)),
      };
    }
    return {
      inputKey: getInputKey(props.workspaceId),
      attachmentsKey: getInputAttachmentsKey(props.workspaceId),
      modelKey: getModelKey(props.workspaceId),
    };
  })();

  // User request: keep creation runtime controls synced with Settings enablement toggles.
  const [rawRuntimeEnablement] = usePersistedState(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );
  const runtimeEnablement = normalizeRuntimeEnablement(rawRuntimeEnablement);

  const [input, setInput] = usePersistedState(storageKeys.inputKey, "", { listener: true });

  // Keep a stable reference to the latest input value so event handlers don't need to rebind
  // on same-length edits (e.g. selection-replace) to know the previous value.
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  // Track concurrent sends with a counter (not boolean) to handle queued follow-ups correctly.
  // When a follow-up is queued during stream-start, it resolves immediately but shouldn't
  // clear the "in flight" state until all sends complete.
  const [sendingCount, setSendingCount] = useState(0);
  const isSending = sendingCount > 0;
  const [hideReviewsDuringSend, setHideReviewsDuringSend] = useState(false);
  const projectedWorkflowRunCardKeysRef = useRef(new Set<string>());
  const workflowsRequestIdRef = useRef(0);
  const agentSkillsRequestIdRef = useRef(0);
  const [agentSkillDescriptors, setAgentSkillDescriptors] = useState<AgentSkillDescriptor[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  // State for destructive command confirmation modal (currently only /clear).
  const [pendingDestructiveCommand, setPendingDestructiveCommand] = useState(false);

  const pushToast = useCallback(
    (nextToast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => {
      // Keep a dedicated "info" intent for callsites while rendering with the shared non-error toast style.
      const type = nextToast.type === "info" ? "success" : nextToast.type;
      setToast({ id: Date.now().toString(), ...nextToast, type });
    },
    [setToast]
  );
  // Subscribe to pending send errors from creation flow. Uses listener: true so
  // late failures (e.g., slow devcontainer startup) still surface a toast.
  const pendingErrorKey =
    variant === "workspace" && workspaceId ? getPendingWorkspaceSendErrorKey(workspaceId) : null;
  const [pendingError, setPendingError] = usePersistedState<SendMessageError | null>(
    pendingErrorKey ?? "__unused__",
    null,
    { listener: true }
  );
  useEffect(() => {
    if (!pendingErrorKey || !pendingError) return;
    setToast(createErrorToast(pendingError));
    setPendingError(null);
  }, [pendingErrorKey, pendingError, setPendingError]);

  const handleToastDismiss = useCallback(() => {
    setToast(null);
  }, []);

  const {
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
  } = useAttachmentDrafts({
    storageKeys,
    pushToast,
    variant,
    workspaceId,
    api,
    editingMessageForUi,
  });
  // Attached reviews come from parent via props (persisted in pendingReviews state).
  const workspaceIdForComposerClear = variant === "workspace" ? props.workspaceId : null;
  const onDetachAllReviewsForComposerClear =
    variant === "workspace" ? props.onDetachAllReviews : undefined;

  // draftReviews takes precedence when restoring or editing message drafts.
  const attachedReviews = variant === "workspace" ? (props.attachedReviews ?? []) : [];

  // Creation sends can resolve after navigation; guard draft clears on unmounted inputs.
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<ModelSelectorRef>(null);
  const powerMode = usePowerMode();

  // Consolidated suggestion menus hook (@file, $skill, /slash, \symbol)
  const suggestionMenus = useSuggestionMenus({
    input,
    setInput,
    inputRef,
    api,
    variant,
    workspaceId,
    projectPath: atMentionProjectPath ?? undefined,
    agentSkillDescriptors,
    experiments: {
      workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
      dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
      memory: memoryExperimentEnabled,
      memoryConsolidation: memoryConsolidationExperimentEnabled,
    },
  });

  const handleInputChange = useCallback(
    (next: string, caretFromEvent?: number) => {
      if (powerMode.enabled) {
        const prev = latestInputValueRef.current;
        const delta = next.length - prev.length;

        if (next !== prev) {
          // Power Mode positioning depends on the textarea's post-layout size/position.
          // On backspace/delete the textarea can shrink (auto-resize) which shifts the caret
          // downward; if we measure immediately we can get a stale bounding rect and the
          // fireworks appear out-of-sync with the cursor.
          const intensity = delta > 0 ? Math.min(6, delta) : delta < 0 ? Math.min(6, -delta) : 1;
          const kind = delta < 0 ? "delete" : "insert";
          // Capture the caret index now (before rAF) so bursts queued within the same frame
          // don't all measure the latest caret position and appear "ahead" during fast typing.
          const caretIndex = caretFromEvent ?? inputRef.current?.selectionStart ?? next.length;

          requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) {
              return;
            }

            const emit = () => powerMode.burstFromTextarea(el, intensity, kind, caretIndex);

            // When the textarea is scrollable, scrollTop may settle one frame after
            // the layout shift, so defer measurement to a second rAF.
            if (el.scrollHeight > el.clientHeight) {
              requestAnimationFrame(emit);
              return;
            }

            emit();
          });
        }
      }

      // Auto-convert a backslash symbol command (e.g. "\alpha" -> α, "\leq" -> ≤).
      // Eager path fires only for unambiguous names; the terminator path accepts
      // a completed name when a space/punctuation follows (e.g. "\in " -> "∈ ").
      // Both only act at the caret, so partial/mid-word edits are left untouched.
      const caret = caretFromEvent ?? inputRef.current?.selectionStart ?? next.length;
      const converted =
        convertSymbolCommandAtCursor(next, caret) ?? convertTerminatedSymbolCommand(next, caret);
      if (converted) {
        setInput(converted.text);
        const newCursor = converted.cursor;
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el || el.disabled) {
            return;
          }
          el.selectionStart = newCursor;
          el.selectionEnd = newCursor;
        });
        return;
      }

      setInput(next);
    },
    [powerMode, setInput]
  );

  // Draft state combines text input and attachments.
  // Reviews are sourced separately via attachedReviews unless draftReviews overrides them.
  interface DraftState {
    text: string;
    attachments: ChatAttachment[];
  }
  const getDraft = useCallback(
    (): DraftState => ({ text: input, attachments }),
    [input, attachments]
  );
  const setDraft = useCallback(
    (draft: DraftState) => {
      setInput(draft.text);
      setAttachments(draft.attachments);
    },
    [setInput, setAttachments]
  );
  const preEditDraftRef = useRef<DraftState>({ text: "", attachments: [] });
  const preEditReviewsRef = useRef<ReviewNoteDataForDisplay[] | null>(null);
  const { open } = useSettings();
  const { selectedWorkspace } = useWorkspaceContext();
  const { agentId, currentAgent } = useAgent();

  // Use current agent's uiColor, or neutral border until agents load
  const focusBorderColor = currentAgent?.uiColor ?? "var(--color-border-light)";
  const {
    models,
    hiddenModelsForSelector,
    ensureModelInSettings,
    defaultModel,
    setDefaultModel,
    codexOauthSet,
    requiresCodexOauth,
  } = useModelsFromSettings();

  const telemetry = useTelemetry();
  const [vimEnabled, setVimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, {
    listener: true,
  });
  const { startSequence: startTutorial } = useTutorial();

  // Track transcription provider prerequisites from Settings → Providers.
  const [openAIKeySet, setOpenAIKeySet] = useState(false);
  const [openAIProviderEnabled, setOpenAIProviderEnabled] = useState(true);
  const [muxGatewayCouponSet, setMuxGatewayCouponSet] = useState(false);
  const [muxGatewayEnabled, setMuxGatewayEnabled] = useState(true);
  const isTranscriptionAvailable =
    (openAIProviderEnabled && openAIKeySet) || (muxGatewayEnabled && muxGatewayCouponSet);

  // Voice input - appends transcribed text to input
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setInput((prev) => {
        const separator = prev.length > 0 && !prev.endsWith(" ") ? " " : "";
        return prev + separator + text;
      });
    },
    onError: (error) => {
      pushToast({ type: "error", message: error });
    },
    onSend: () => void handleSend(),
    isTranscriptionAvailable,
    useRecordingKeybinds: true,
    api,
  });

  const voiceInputUnavailableMessage =
    "Voice input requires a Mux Gateway login or an OpenAI API key. Configure in Settings → Providers.";

  // Start creation tutorial when entering creation mode
  useEffect(() => {
    if (variant === "creation") {
      // Small delay to ensure UI is rendered
      const timer = setTimeout(() => {
        startTutorial("creation");
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [variant, startTutorial]);

  // Get current send message options from shared hook (must be at component top level)
  // For creation variant, use project-scoped key; for workspace, use workspace ID
  const sendMessageOptions = useSendMessageOptions(
    variant === "workspace" ? props.workspaceId : getProjectScopeId(creationParentProjectPath)
  );
  const additionalSystemContext = useAdditionalSystemContextSnapshot(
    variant === "workspace" ? props.workspaceId : ""
  );
  const additionalSystemContextHydrated = useAdditionalSystemContextHydrated(
    variant === "workspace" ? props.workspaceId : ""
  );
  // Extract models for convenience (don't create separate state - use hook as single source of truth)
  // - preferredModel: selected model used for backend routing, preserving explicit gateway choices
  // - baseModel: canonical format for UI display and policy checks (e.g., ThinkingSlider)
  const preferredModel = sendMessageOptions.model;
  const baseModel = sendMessageOptions.baseModel;

  // Context usage indicator data (workspace variant only)
  const workspaceIdForUsage = variant === "workspace" ? props.workspaceId : "";
  const usage = useWorkspaceUsage(workspaceIdForUsage);
  const { has1MContext } = useProviderOptions();
  const { config: providersConfig } = useProvidersConfig();
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  // Token counts come from usage metadata, but context limits/1M eligibility should
  // follow the currently selected model unless a stream is actively running.
  const activeUsageModel = usage?.liveUsage?.model ?? null;
  const contextDisplayModel = activeUsageModel ?? baseModel;
  const use1M = has1MContext(contextDisplayModel);
  const contextUsageData = useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, contextDisplayModel, use1M, false, providersConfig)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, contextDisplayModel, use1M, providersConfig]);
  const { threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold } =
    useAutoCompactionSettings(workspaceIdForUsage, contextDisplayModel);
  const autoCompactionProps = useMemo(
    () => ({ threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold }),
    [autoCompactThreshold, setAutoCompactThreshold]
  );

  // Idle compaction settings (per-project, persisted to backend for idleCompactionService)
  const { hours: idleCompactionHours, setHours: setIdleCompactionHours } = useIdleCompactionHours({
    projectPath: selectedWorkspace?.projectPath ?? null,
  });
  const idleCompactionProps = useMemo(
    () => ({
      hours: idleCompactionHours,
      setHours: setIdleCompactionHours,
    }),
    [idleCompactionHours, setIdleCompactionHours]
  );

  const { setPreferredModel, cycleToNextModel } = useWorkspaceModelSelection({
    variant,
    workspaceId,
    agentId,
    thinkingLevel,
    baseModel,
    models,
    defaultModel,
    ensureModelInSettings,
    onModelChange,
    workspaceGoal,
    providersConfig,
    api,
    creationParentProjectPath,
    setToast,
  });

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.open();
  }, []);
  const hasCreationRuntimeOverrides =
    creationProject?.runtimeOverridesEnabled === true ||
    Boolean(creationProject?.runtimeEnablement) ||
    creationProject?.defaultRuntime !== undefined;
  // Keep workspace creation in sync with Settings → Runtimes project overrides.
  const creationRuntimeEnablement =
    variant === "creation" && hasCreationRuntimeOverrides
      ? normalizeRuntimeEnablement(creationProject?.runtimeEnablement)
      : runtimeEnablement;
  const [hasAttemptedCreateSend, setHasAttemptedCreateSend] = useState(false);

  // Creation-specific state (hook always called, but only used when variant === "creation")
  // This avoids conditional hook calls which violate React rules
  const creationNameMessage =
    variant === "creation"
      ? (() => {
          const parsedCreationCommand = parseCommand(input.trim());
          return parsedCreationCommand?.type === "goal-set"
            ? parsedCreationCommand.objective
            : input;
        })()
      : "";
  const creationState = useCreationWorkspace(
    variant === "creation"
      ? {
          projectPath: creationParentProjectPath,
          subProjectPath: creationSubProjectPath,
          onWorkspaceCreated: props.onWorkspaceCreated,
          message: creationNameMessage,
          dynamicWorkflowsEnabled: dynamicWorkflowsExperimentEnabled,
          draftId: props.pendingDraftId,
          userModel: preferredModel,
        }
      : {
          // Dummy values for workspace variant (never used)
          projectPath: "",
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onWorkspaceCreated: () => {},
          message: "",
        }
  );

  const isSendInFlight = variant === "creation" ? creationState.isSending : isSending;
  const sendInFlightBlocksInput =
    variant === "workspace" ? isSendInFlight && !isStreamStarting : isSendInFlight;

  // Coder workspace state - config is owned by selectedRuntime.coder, this hook manages async data
  const currentRuntime = creationState.selectedRuntime;
  const coderState = useCoderWorkspace({
    coderConfig: currentRuntime.mode === "ssh" ? (currentRuntime.coder ?? null) : null,
    onCoderConfigChange: (config) => {
      if (currentRuntime.mode !== "ssh") return;
      // Compute host from workspace name for "existing" mode.
      // For "new" mode, workspaceName is omitted/undefined and backend derives it later.
      const computedHost = config?.workspaceName
        ? `${config.workspaceName}.coder`
        : currentRuntime.host;
      creationState.setSelectedRuntime({
        mode: "ssh",
        host: computedHost,
        coder: config ?? undefined,
      });
    },
    coderInfoRefreshPolicy: variant === "creation" ? "mount-and-focus" : "mount-only",
  });

  const creationRuntimeError =
    variant === "creation"
      ? validateCreationRuntime(creationState.selectedRuntime, coderState.presets.length)
      : null;

  const creationRuntimePolicyError =
    variant === "creation" &&
    effectivePolicy?.runtimes != null &&
    !isParsedRuntimeAllowedByPolicy(effectivePolicy, creationState.selectedRuntime)
      ? creationState.selectedRuntime.mode === "ssh" &&
        !creationState.selectedRuntime.coder &&
        runtimePolicy.allowSshHost === false &&
        runtimePolicy.allowSshCoder
        ? "Host SSH runtimes are disabled by policy. Select the Coder runtime instead."
        : "Selected runtime is disabled by policy."
      : null;

  const runtimeFieldError =
    variant === "creation" && hasAttemptedCreateSend ? (creationRuntimeError?.mode ?? null) : null;

  const creationControlsProps =
    variant === "creation"
      ? ({
          branches: creationState.branches,
          branchesLoaded: creationState.branchesLoaded,
          trunkBranch: creationState.trunkBranch,
          onTrunkBranchChange: creationState.setTrunkBranch,
          selectedRuntime: creationState.selectedRuntime,
          coderConfigFallback: creationState.coderConfigFallback,
          sshHostFallback: creationState.sshHostFallback,
          defaultRuntimeMode: creationState.defaultRuntimeMode,
          onSelectedRuntimeChange: creationState.setSelectedRuntime,
          onSetDefaultRuntime: creationState.setDefaultRuntimeChoice,
          disabled: isSendInFlight,
          projectPath: creationParentProjectPath,
          // Surface the actually-targeted project (possibly a sub-project) to
          // the dropdown so the trigger label reflects what the user picked,
          // while runtime/settings scoping stays on the parent above. When
          // creating from the sidebar's "+ New chat" on a sub-project header,
          // the URL/route is the parent project and the sub-project comes via
          // the draft (pendingSubProjectPath / creationSubProjectPath); both
          // routes (deep link to a sub-project, or sidebar "+") collapse here.
          selectedProjectPath: creationSubProjectPath ?? props.projectPath,
          projectName: props.projectName,
          nameState: creationState.nameState,
          runtimeAvailabilityState: creationState.runtimeAvailabilityState,
          runtimeEnablement: creationRuntimeEnablement,
          allowedRuntimeModes: runtimePolicy.allowedModes,
          allowSshHost: runtimePolicy.allowSshHost,
          allowSshCoder: runtimePolicy.allowSshCoder,
          runtimePolicyError: creationRuntimePolicyError,
          coderInfo: coderState.coderInfo,
          runtimeFieldError,
          // Pass coderProps when CLI is available/outdated, Coder is enabled, or still checking (so "Checking…" UI renders)
          coderProps:
            coderState.coderInfo === null ||
            coderState.enabled ||
            coderState.coderInfo?.state !== "unavailable"
              ? {
                  enabled: coderState.enabled,
                  onEnabledChange: coderState.setEnabled,
                  coderInfo: coderState.coderInfo,
                  coderConfig: coderState.coderConfig,
                  onCoderConfigChange: coderState.setCoderConfig,
                  templates: coderState.templates,
                  templatesError: coderState.templatesError,
                  presets: coderState.presets,
                  presetsError: coderState.presetsError,
                  existingWorkspaces: coderState.existingWorkspaces,
                  workspacesError: coderState.workspacesError,
                  loadingTemplates: coderState.loadingTemplates,
                  loadingPresets: coderState.loadingPresets,
                  loadingWorkspaces: coderState.loadingWorkspaces,
                }
              : undefined,
        } satisfies React.ComponentProps<typeof CreationControls>)
      : null;
  const hasTypedText = input.trim().length > 0;
  const hasImages = attachments.length > 0;
  const reviewOverrideActive = draftReviews !== null;
  const draftReviewItems = draftReviews ?? [];
  const reviewData = reviewOverrideActive
    ? draftReviewItems.length > 0
      ? draftReviewItems
      : undefined
    : attachedReviews.length > 0
      ? attachedReviews.map((review) => review.data)
      : undefined;
  const reviewIdsForCheck = reviewOverrideActive ? [] : attachedReviews.map((review) => review.id);
  const reviewPanelItems: Review[] = reviewOverrideActive
    ? draftReviewItems.map((data) => ({
        id: getDraftReviewId(data),
        data,
        status: "attached",
        createdAt: 0,
      }))
    : attachedReviews;
  const hasReviews = reviewData !== undefined;
  // Disable send while Coder presets are loading (user could bypass preset validation)
  const policyBlocksCreateSend = variant === "creation" && creationRuntimePolicyError != null;
  const coderPresetsLoading =
    coderState.enabled && !coderState.coderConfig?.existingWorkspace && coderState.loadingPresets;
  const isProcessingAttachments = processingAttachmentCount > 0;
  const canSend =
    (hasTypedText || hasImages || hasReviews) &&
    !disabled &&
    !sendInFlightBlocksInput &&
    !isProcessingAttachments &&
    !coderPresetsLoading &&
    !policyBlocksCreateSend;
  const runningGoalActive =
    variant === "workspace" && isGoalRunning(workspaceGoal?.status ?? "paused");

  const canChooseDispatchMode = variant === "workspace" && canSend;

  // Expose ChatInput auto-focus completion for Storybook/tests.
  const chatInputSectionRef = useRef<HTMLDivElement | null>(null);
  const setChatInputAutoFocusState = useCallback((state: "pending" | "done") => {
    chatInputSectionRef.current?.setAttribute("data-autofocus-state", state);
  }, []);

  const focusMessageInput = useCallback(() => {
    const element = inputRef.current;
    if (!element || element.disabled) {
      return;
    }

    element.focus();

    requestAnimationFrame(() => {
      const cursor = element.value.length;
      element.selectionStart = cursor;
      element.selectionEnd = cursor;
      // Skip the resize dance when empty: reading scrollHeight after a height write
      // forces a synchronous reflow, and this rAF fires right after a workspace
      // switch while the freshly mounted transcript is still dirty — laying out the
      // whole document before first paint. Empty composers are sized by CSS alone
      // (rows=1 + min-height; see useAutoResizeTextarea).
      if (element.value !== "") {
        element.style.height = "auto";
        element.style.height = Math.min(element.scrollHeight, window.innerHeight * 0.5) + "px";
      }
    });
  }, []);

  const applyDraftFromPending = useCallback(
    (pending: PendingUserMessage, attachmentKeyPrefix: string) => {
      const providerAttachments = filePartsToChatAttachments(
        pending.fileParts,
        attachmentKeyPrefix
      );
      const stagedAttachments = pending.stagedAttachments.map((attachment, index) => ({
        ...attachment,
        id: `${attachmentKeyPrefix}-staged-${index}`,
      }));
      setDraft({
        text: pending.content,
        attachments: [...providerAttachments, ...stagedAttachments],
      });
    },
    [setDraft]
  );

  // Restore a full pending draft (text + attachments + reviews), e.g. queued message edits.
  const restoreDraft = useCallback(
    (pending: PendingUserMessage) => {
      applyDraftFromPending(pending, `restored-${Date.now()}`);
      setDraftReviews(pending.reviews);
      focusMessageInput();
    },
    [applyDraftFromPending, focusMessageInput, setDraftReviews]
  );

  const restorePreEditDraft = useCallback(() => {
    setDraft(preEditDraftRef.current);
    setDraftReviews(preEditReviewsRef.current);
  }, [setDraft, setDraftReviews]);

  // Method to restore text to input (used by compaction cancel)
  const restoreText = useCallback(
    (text: string) => {
      setInput(() => text);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  // Method to append text to input (used by Code Review notes)
  const appendText = useCallback(
    (text: string) => {
      setInput((prev) => {
        // Add blank line before if there's existing content
        const separator = prev.trim() ? "\n\n" : "";
        return prev + separator + text;
      });
      // Don't focus - user wants to keep reviewing
    },
    [setInput]
  );

  // Method to prepend text to input (used by manual compact trigger)
  const prependText = useCallback(
    (text: string) => {
      setInput((prev) => text + prev);
      focusMessageInput();
    },
    [focusMessageInput, setInput]
  );

  const handleSendRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const send = useCallback(() => {
    return handleSendRef.current();
  }, []);

  const onReady = props.onReady;

  // Provide API to parent via callback
  useEffect(() => {
    if (onReady) {
      onReady({
        focus: focusMessageInput,
        send,
        restoreText,
        restoreDraft,
        appendText,
        prependText,
      });
    }
  }, [onReady, focusMessageInput, send, restoreText, restoreDraft, appendText, prependText]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_I)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.FOCUS_INPUT_A)) {
        event.preventDefault();
        focusMessageInput();
        return;
      }

      if (matchesKeybind(event, KEYBINDS.CYCLE_MODEL)) {
        event.preventDefault();
        focusMessageInput();
        cycleToNextModel();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [cycleToNextModel, focusMessageInput, openModelSelector]);

  // When entering editing mode, save current draft and populate with message content
  useEffect(() => {
    if (editingMessage) {
      preEditDraftRef.current = getDraft();
      preEditReviewsRef.current = draftReviews;
      applyDraftFromPending(editingMessage.pending, `edit-${editingMessage.id}`);
      setDraftReviews(editingMessage.pending.reviews);
      // Auto-resize textarea and focus
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
          inputRef.current.style.height =
            Math.min(inputRef.current.scrollHeight, window.innerHeight * 0.5) + "px";
          inputRef.current.focus();
        }
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when editingMessage changes
  }, [editingMessage, applyDraftFromPending]);

  // Project live workflow run cards for foreground slash invocations after reloads.
  useEffect(() => {
    let isMounted = true;
    const requestId = ++workflowsRequestIdRef.current;

    const loadWorkflows = async () => {
      if (!api || !dynamicWorkflowsExperimentEnabled) {
        return;
      }

      try {
        const discoveryWorkspaceId = variant === "workspace" && workspaceId ? workspaceId : null;
        const runs =
          discoveryWorkspaceId != null && isTranscriptCaughtUp
            ? await api.workflows.listRuns({ workspaceId: discoveryWorkspaceId })
            : [];
        if (!isMounted || workflowsRequestIdRef.current !== requestId) {
          return;
        }
        if (discoveryWorkspaceId == null) {
          return;
        }
        const muxMessages = store.getWorkspaceState(discoveryWorkspaceId).muxMessages;
        for (const run of runs) {
          const projection = getWorkflowRunCardProjection(muxMessages, run);
          if (!projection.shouldProject) {
            continue;
          }
          const cardKey = `${discoveryWorkspaceId}:${run.id}:${run.updatedAt}:${run.status}`;
          if (projectedWorkflowRunCardKeysRef.current.has(cardKey)) {
            continue;
          }
          projectedWorkflowRunCardKeysRef.current.add(cardKey);
          addWorkflowRunCardMessageForRun(discoveryWorkspaceId, run, {
            existingMessage: projection.existingMessage,
          });
        }
      } catch (error) {
        console.error("Failed to project workflow run cards:", error);
      }
    };

    void loadWorkflows();

    return () => {
      isMounted = false;
    };
  }, [
    api,
    variant,
    workspaceId,
    atMentionProjectPath,
    dynamicWorkflowsExperimentEnabled,
    isTranscriptCaughtUp,
    store,
  ]);

  // Load agent skills for suggestions
  useEffect(() => {
    let isMounted = true;
    const requestId = ++agentSkillsRequestIdRef.current;

    const loadAgentSkills = async () => {
      if (!api) {
        if (isMounted && agentSkillsRequestIdRef.current === requestId) {
          setAgentSkillDescriptors([]);
        }
        return;
      }

      const discoveryInput =
        variant === "workspace" && workspaceId
          ? {
              workspaceId,
              disableWorkspaceAgents: sendMessageOptions.disableWorkspaceAgents,
            }
          : variant === "creation" && atMentionProjectPath
            ? { projectPath: atMentionProjectPath }
            : null;

      if (!discoveryInput) {
        if (isMounted && agentSkillsRequestIdRef.current === requestId) {
          setAgentSkillDescriptors([]);
        }
        return;
      }

      try {
        const skills = await api.agentSkills.list(discoveryInput);
        if (!isMounted || agentSkillsRequestIdRef.current !== requestId) {
          return;
        }
        if (Array.isArray(skills)) {
          setAgentSkillDescriptors(skills);
        }
      } catch (error) {
        console.error("Failed to load agent skills:", error);
        if (!isMounted || agentSkillsRequestIdRef.current !== requestId) {
          return;
        }
        setAgentSkillDescriptors([]);
      }
    };

    void loadAgentSkills();

    return () => {
      isMounted = false;
    };
  }, [api, variant, workspaceId, atMentionProjectPath, sendMessageOptions.disableWorkspaceAgents]);

  // Voice input: track transcription provider availability (subscribe to provider config changes)
  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Some oRPC iterators don't eagerly close on abort alone.
    // Ensure we `return()` them so backend subscriptions clean up EventEmitter listeners.
    let iterator: AsyncIterator<unknown> | null = null;

    const checkTranscriptionConfig = async () => {
      try {
        const config = await api.providers.getConfig();
        if (!signal.aborted) {
          setOpenAIKeySet(config?.openai?.apiKeySet ?? false);
          setOpenAIProviderEnabled(config?.openai?.isEnabled ?? true);
          setMuxGatewayCouponSet(config?.["mux-gateway"]?.couponCodeSet ?? false);
          setMuxGatewayEnabled(config?.["mux-gateway"]?.isEnabled ?? true);
        }
      } catch {
        // Ignore errors fetching config
      }
    };

    // Initial fetch
    void checkTranscriptionConfig();

    // Subscribe to provider config changes via oRPC
    (async () => {
      try {
        const subscribedIterator = await api.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void checkTranscriptionConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  useChatInputExternalEvents({
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
  });

  useChatInputToasts({
    variant,
    workspaceId,
    pushToast,
    voiceInput,
    voiceInputUnavailableMessage,
  });

  // Auto-focus chat input when workspace changes (workspace only).
  const workspaceIdForFocus = variant === "workspace" ? props.workspaceId : null;
  useEffect(() => {
    if (variant !== "workspace") return;

    const maxFrames = 10;
    setChatInputAutoFocusState("pending");

    let cancelled = false;
    let rafId: number | null = null;
    let attempts = 0;

    const step = () => {
      if (cancelled) return;

      attempts += 1;

      const input = inputRef.current;
      const active = document.activeElement;

      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        const isWithinChatInput = !!chatInputSectionRef.current?.contains(active);
        const isInput = !!input && active === input;
        if (!isWithinChatInput && !isInput) {
          setChatInputAutoFocusState("done");
          return;
        }
      }

      focusMessageInput();

      const isFocused = !!input && document.activeElement === input;
      const isDone = isFocused || attempts >= maxFrames;

      if (isDone) {
        setChatInputAutoFocusState("done");
        return;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      setChatInputAutoFocusState("done");
    };
  }, [variant, workspaceIdForFocus, focusMessageInput, setChatInputAutoFocusState]);

  // Shared slash command execution for creation + workspace inputs.
  const commandWorkspaceId = variant === "workspace" ? props.workspaceId : undefined;
  const commandProjectPath =
    variant === "creation" ? props.projectPath : (selectedWorkspace?.projectPath ?? null);
  const commandOnCancelEdit = variant === "workspace" ? props.onCancelEdit : undefined;

  // Keep this helper as a plain function so command wiring stays readable without a giant
  // dependency list; the React Compiler already handles memoization.
  const executeParsedCommand = async (
    parsed: ParsedCommand | null,
    restoreInput: string,
    options?: {
      skipConfirmation?: boolean;
      queueDispatchMode?: QueueDispatchMode;
      goalInterventionPolicy?: GoalInterventionPolicy;
    }
  ): Promise<boolean> => {
    if (!parsed) {
      return false;
    }

    // /<model-alias> ... is a *send modifier* (one-shot model override), not a command with its own
    // side effects. Let the normal send flow handle it so post-send behavior can't drift.
    if (parsed.type === "model-oneshot") {
      if (variant !== "workspace") {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: "Model one-shot is only available in workspace view",
        });
        return true;
      }
      return false;
    }

    const isDestructive = parsed.type === "clear" && parsed.mode === "hard";
    if (isDestructive && variant === "workspace" && !options?.skipConfirmation) {
      setPendingDestructiveCommand(true);
      return true;
    }

    if (getStagedAttachments(attachments).length > 0 && parsed.type !== "compact") {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message:
          "This command cannot include staged ZIP attachments. Remove the ZIP or send a normal message.",
      });
      return true;
    }

    const reviewsData = reviewData;
    const dispatchMode = options?.queueDispatchMode ?? "tool-end";
    // Thread dispatch mode into send options so queued command sends stay in sync with normal sends.
    const commandSendMessageOptions: SendMessageOptions = {
      ...sendMessageOptions,
      ...(options?.goalInterventionPolicy
        ? { goalInterventionPolicy: options.goalInterventionPolicy }
        : {}),
      ...(dispatchMode === "tool-end" ? {} : { queueDispatchMode: dispatchMode }),
    };
    // Prepare file parts for commands that need to send messages with attachments
    const commandFileParts = chatAttachmentsToFileParts(attachments, { validate: true });
    const asyncCommandToken = ++asyncCommandTokenRef.current;
    const commandContext: SlashCommandContext = {
      api,
      variant,
      workspaceId: commandWorkspaceId,
      projectPath: commandProjectPath,
      rawInput: restoreInput,
      dynamicWorkflowsEnabled: dynamicWorkflowsExperimentEnabled,
      openSettings: open,
      currentModel: workspaceSidebarState?.currentModel ?? null,
      sendMessageOptions: commandSendMessageOptions,
      getInput: () => getDraft().text,
      setInput,
      setAttachments,
      setSendingState: (increment: boolean) => setSendingCount((c) => c + (increment ? 1 : -1)),
      setToast,
      setPreferredModel,
      setVimEnabled,
      asyncCommandToken,
      isAsyncCommandCurrent: (token, originWorkspaceId) => {
        const scope = asyncCommandScopeRef.current;
        return (
          token === asyncCommandTokenRef.current &&
          scope.variant === "workspace" &&
          scope.workspaceId === originWorkspaceId
        );
      },
      onResetContext: variant === "workspace" ? props.onResetContext : undefined,
      onTruncateHistory: variant === "workspace" ? props.onTruncateHistory : undefined,
      resetInputHeight: () => {
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }
      },
      editMessageId: editingMessageForUi?.id,
      onCancelEdit: commandOnCancelEdit,
      reviews: reviewsData,
      attachments,
      fileParts: commandFileParts.length > 0 ? commandFileParts : undefined,
      onMessageSent: variant === "workspace" ? props.onMessageSent : undefined,
      onDetachAllReviews: variant === "workspace" ? props.onDetachAllReviews : undefined,
      onCheckReviews: variant === "workspace" ? props.onCheckReviews : undefined,
      attachedReviewIds: reviewIdsForCheck,
    };

    const result = await processSlashCommand(parsed, commandContext);

    if (!result.clearInput) {
      setInput(restoreInput);
    } else {
      setDraftReviews(null);
      if (variant === "workspace" && parsed.type === "compact") {
        if (reviewIdsForCheck.length > 0) {
          props.onCheckReviews?.(reviewIdsForCheck);
        }
        props.onMessageSent?.(dispatchMode);
      }
    }

    return true;
  };

  // Handle destructive command confirmation (currently only /clear).
  const handleDestructiveCommandConfirm = async () => {
    if (!pendingDestructiveCommand || variant !== "workspace") return;

    const parsedCommand: ParsedCommand = { type: "clear", mode: "hard" };

    setPendingDestructiveCommand(false);
    await executeParsedCommand(parsedCommand, input, { skipConfirmation: true });
  };

  const handleDestructiveCommandCancel = useCallback(() => {
    setPendingDestructiveCommand(false);
  }, []);

  const handleSend = async (overrides?: InternalSendOverrides) => {
    if (!canSend) {
      return;
    }

    const messageText = input.trim();
    const skillDiscovery: SkillResolutionTarget | null =
      variant === "creation"
        ? atMentionProjectPath
          ? { kind: "project", projectPath: atMentionProjectPath }
          : null
        : variant === "workspace" && workspaceId
          ? {
              kind: "workspace",
              workspaceId,
              disableWorkspaceAgents: sendMessageOptions.disableWorkspaceAgents,
            }
          : null;
    const { parsed, skillInvocation } = await parseCommandWithSkillInvocation({
      messageText,
      agentSkillDescriptors,
      api,
      discovery: skillDiscovery,
    });
    const combinedSkillRefs = await resolveInlineSkillRefsForSend({
      messageText,
      slashInvocation: skillInvocation,
      agentSkillDescriptors,
      api,
      discovery: skillDiscovery,
    });

    // Route to creation handler for creation variant
    if (variant === "creation") {
      const initialSlashCommand = parsed?.type === "goal-set" ? parsed : undefined;
      if (!initialSlashCommand && parsed?.type !== "workflow-run") {
        const commandHandled = await executeParsedCommand(parsed, input);
        if (commandHandled) {
          return;
        }
      }

      let creationMessageTextForSend =
        initialSlashCommand?.type === "goal-set" ? initialSlashCommand.objective : messageText;
      let creationOptionsOverride: Partial<SendMessageOptions> | undefined;

      if (skillInvocation) {
        if (!api) {
          pushToast({ type: "error", message: "Not connected to server" });
          return;
        }

        creationMessageTextForSend = skillInvocation.userText;
      }

      if (combinedSkillRefs.length > 0) {
        const baseMetadata = skillInvocation
          ? buildSkillInvocationMetadata(messageText, skillInvocation.descriptor)
          : undefined;
        const muxMetadata = withAgentSkillRefs(baseMetadata, combinedSkillRefs);
        if (!muxMetadata) {
          throw new Error("Expected skill metadata when skill refs are present");
        }

        creationOptionsOverride = {
          muxMetadata,
          // In the creation flow, project-scoped skills may not exist in the new worktree.
          // Force project-path discovery for this send so resolution matches suggestions.
          ...(hasProjectScopedSkillRef(combinedSkillRefs) ? { disableWorkspaceAgents: true } : {}),
        };
      }

      setHasAttemptedCreateSend(true);

      const runtimeError = validateCreationRuntime(
        creationState.selectedRuntime,
        coderState.presets.length
      );
      if (runtimeError) {
        return;
      }

      // Creation variant: simple message send + workspace creation
      const creationFileParts = chatAttachmentsToFileParts(attachments);
      const creationResult = await creationState.handleSend(
        creationMessageTextForSend,
        creationFileParts.length > 0 ? creationFileParts : undefined,
        creationOptionsOverride,
        initialSlashCommand
      );

      if (creationResult.success) {
        if (isMountedRef.current) {
          setInput("");
          setAttachments([]);
          // Height is managed by VimTextArea's useLayoutEffect - clear inline style
          // to let CSS min-height take over
          if (inputRef.current) {
            inputRef.current.style.height = "";
          }
        }
      }
      return;
    }

    // Workspace variant: full command handling + message send
    if (variant !== "workspace") return; // Type guard

    if (
      editingMessageForUi?.isBeforeLatestContextBoundary === true &&
      overrides?.skipBoundaryEditConfirmation !== true
    ) {
      // Re-enable the old pre-compaction edit flow, but confirm at send time because
      // the backend truncates through the context boundary and discards its summary.
      setPendingBoundaryEditConfirmation({
        ...(overrides?.queueDispatchMode ? { queueDispatchMode: overrides.queueDispatchMode } : {}),
        ...(overrides?.goalInterventionPolicy
          ? { goalInterventionPolicy: overrides.goalInterventionPolicy }
          : {}),
      });
      return;
    }

    try {
      const modelOneShot = parsed?.type === "model-oneshot" ? parsed : null;
      const commandHandled = modelOneShot
        ? false
        : await executeParsedCommand(parsed, input, {
            goalInterventionPolicy: overrides?.goalInterventionPolicy,
            queueDispatchMode: overrides?.queueDispatchMode,
          });
      if (commandHandled) {
        return;
      }

      // A normal workspace send supersedes any pending fire-and-forget slash
      // command completion (notably /btw). If that older async command fails
      // after this send clears the composer, it must not restore stale command
      // text over the newer turn.
      asyncCommandTokenRef.current++;

      const modelOverride = modelOneShot?.modelString;

      // Regular message (or /<model-alias> one-shot override) - send directly via API
      const messageTextForSend = modelOneShot?.message ?? skillInvocation?.userText ?? messageText;
      const skillMuxMetadata = skillInvocation
        ? buildSkillInvocationMetadata(
            appendStagedAttachmentNotice(messageText, attachments),
            skillInvocation.descriptor
          )
        : undefined;

      if (!api) {
        pushToast({ type: "error", message: "Not connected to server" });
        return;
      }
      setSendingCount((c) => c + 1);

      const policyModel = modelOverride ?? baseModel;

      // Preflight: if the message includes PDFs, ensure the selected model can accept them.
      const pdfPreflight = preflightPdfAttachments(policyModel, attachments, providersConfig);
      if (!pdfPreflight.ok) {
        pushToast({ type: "error", ...pdfPreflight.error! });
        setSendingCount((c) => c - 1);
        return;
      }
      // Save current draft state for restoration on error
      const preSendDraft = getDraft();
      const preSendReviews = draftReviews;
      const editMessageForSend = editingMessageForUi;

      try {
        // Prepare file parts if any
        const fileParts = chatAttachmentsToFileParts(attachments, { validate: true });
        const sendFileParts = editMessageForSend
          ? fileParts
          : fileParts.length > 0
            ? fileParts
            : undefined;

        // Prepare reviews data (used for both compaction continueMessage and normal send)
        const reviewsData = reviewData;

        // When editing a /compact command, regenerate the actual summarization request
        let actualMessageText = messageTextForSend;
        let muxMetadata: MuxMessageMetadata | undefined = skillMuxMetadata;
        if (combinedSkillRefs.length > 0) {
          muxMetadata = withAgentSkillRefs(muxMetadata, combinedSkillRefs);
        }

        let compactionOptions: Partial<SendMessageOptions> = {};
        let appendStagedNoticeToUserMessage = true;

        if (editMessageForSend && actualMessageText.startsWith("/")) {
          const parsedEdit = parseCommand(messageText);
          if (parsedEdit?.type === "compact") {
            const regen = regenerateCompactionEditMessage({
              messageText: actualMessageText,
              api,
              workspaceId: props.workspaceId,
              parsed: parsedEdit,
              attachments,
              reviews: reviewsData,
              sendFileParts,
              sendMessageOptions,
              existingMetadata: muxMetadata,
            });
            actualMessageText = regen.actualMessageText;
            muxMetadata = regen.muxMetadata;
            compactionOptions = regen.compactionOptions;
            appendStagedNoticeToUserMessage = regen.appendStagedNoticeToUserMessage;
          }
        }

        const { finalText: finalMessageText, metadata: reviewMetadata } =
          prepareWorkspaceMessageForSend({
            actualMessageText,
            attachments,
            appendStagedNotice: appendStagedNoticeToUserMessage,
            reviews: reviewsData,
            existingMetadata: muxMetadata,
            combinedSkillRefs,
          });
        // When editing /compact, compactionOptions already includes the base sendMessageOptions.
        // Avoid duplicating additionalSystemInstructions.
        const additionalSystemInstructions =
          compactionOptions.additionalSystemInstructions ??
          sendMessageOptions.additionalSystemInstructions;

        muxMetadata = reviewMetadata;

        const effectiveModel = modelOverride ?? compactionOptions.model ?? sendMessageOptions.model;
        // For one-shot overrides, store the original input as rawCommand so the
        // command prefix (e.g., "/opus+high") stays visible in the user message.
        const oneshotCommandPrefix = modelOneShot
          ? messageText
              .trim()
              .slice(0, messageText.trim().length - modelOneShot.message.length)
              .trimEnd()
          : undefined;
        const oneshotRawCommand = oneshotCommandPrefix
          ? appendStagedAttachmentNotice(messageText.trim(), attachments)
          : undefined;
        muxMetadata = muxMetadata
          ? {
              ...muxMetadata,
              requestedModel: effectiveModel,
              ...(oneshotRawCommand
                ? { rawCommand: oneshotRawCommand, commandPrefix: oneshotCommandPrefix }
                : {}),
            }
          : {
              type: "normal",
              requestedModel: effectiveModel,
              ...(oneshotRawCommand
                ? { rawCommand: oneshotRawCommand, commandPrefix: oneshotCommandPrefix }
                : {}),
            };

        // Capture review IDs before clearing (for marking as checked on success)
        const sentReviewIds = reviewIdsForCheck;

        if (editMessageForSend) {
          setOptimisticallyDismissedEditId(editMessageForSend.id);
        }

        // Clear input, images, and hide reviews immediately for responsive UI
        // Text/images are restored if send fails; reviews remain "attached" in state
        // so they'll reappear naturally on failure (we only call onCheckReviews on success)
        setInput("");
        setDraftReviews(null);
        setAttachments([]);
        setHideReviewsDuringSend(true);
        // Clear inline height style - VimTextArea's useLayoutEffect will handle sizing
        if (inputRef.current) {
          inputRef.current.style.height = "";
        }

        // One-shot models/thinking shouldn't update the persisted session defaults.
        // Resolve thinking level: numeric indices are model-relative (0 = model's lowest allowed level)
        const rawThinkingOverride = modelOneShot?.thinkingLevel;
        const thinkingOverride =
          rawThinkingOverride != null
            ? resolveThinkingInput(rawThinkingOverride, policyModel)
            : undefined;

        const sendOptions = assembleWorkspaceSendOptions({
          sendMessageOptions,
          compactionOptions,
          modelOverride,
          thinkingOverride,
          isModelOneShot: Boolean(modelOneShot),
          goalInterventionPolicy: overrides?.goalInterventionPolicy,
          queueDispatchMode: overrides?.queueDispatchMode,
          additionalSystemContextEnabled: additionalSystemContext.enabled,
          additionalSystemContextContent: additionalSystemContext.content,
          additionalSystemContextHydrated,
          additionalSystemInstructions,
          editMessageId: editMessageForSend?.id,
          fileParts: sendFileParts,
          muxMetadata,
        });

        props.onMessageSendStarted?.(overrides?.queueDispatchMode ?? "tool-end");

        const result = await api.workspace.sendMessage({
          workspaceId: props.workspaceId,
          message: finalMessageText,
          options: sendOptions,
        });

        if (!result.success) {
          // Log error for debugging
          console.error("Failed to send message:", result.error);
          // Show error using enhanced toast
          setToast(createErrorToast(result.error));
          // Restore draft on error so user can try again
          setOptimisticallyDismissedEditId(null);
          setDraft(preSendDraft);
          setDraftReviews(preSendReviews);
        } else {
          // Track telemetry for successful message send
          telemetry.messageSent(
            props.workspaceId,
            effectiveModel,
            sendMessageOptions.agentId ?? agentId ?? WORKSPACE_DEFAULTS.agentId,
            finalMessageText.length,
            runtimeType,
            sendMessageOptions.thinkingLevel ?? "off"
          );

          if (modelOneShot) {
            trackCommandUsed("model");
          }

          // Mark workspace as read after sending a message.
          // This prevents the unread indicator from showing when the user
          // just interacted with the workspace (their own message bumps recencyTimestamp,
          // but since they initiated it, they've "read" the workspace).
          updatePersistedState(getWorkspaceLastReadKey(props.workspaceId), Date.now());

          // Mark attached reviews as completed (checked)
          if (sentReviewIds.length > 0) {
            props.onCheckReviews?.(sentReviewIds);
          }

          // Exit editing mode if we were editing
          if (editMessageForSend && props.onCancelEdit) {
            props.onCancelEdit();
          } else if (editMessageForSend) {
            setOptimisticallyDismissedEditId(null);
          }
          props.onMessageSent?.(overrides?.queueDispatchMode ?? "tool-end");
        }
      } catch (error) {
        // Handle unexpected errors
        console.error("Unexpected error sending message:", error);
        setToast(
          createErrorToast({
            type: "unknown",
            raw: error instanceof Error ? error.message : "Failed to send message",
          })
        );
        // Restore draft on error
        setOptimisticallyDismissedEditId(null);
        setDraft(preSendDraft);
        setDraftReviews(preSendReviews);
      } finally {
        setSendingCount((c) => c - 1);
        setHideReviewsDuringSend(false);
      }
    } finally {
      // Always restore focus at the end
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  };

  const handleBoundaryEditConfirm = async () => {
    const pendingOverrides = pendingBoundaryEditConfirmation;
    const pendingEdit = editingMessageForUi;
    if (!pendingOverrides || variant !== "workspace" || !pendingEdit) {
      setPendingBoundaryEditConfirmation(null);
      return;
    }

    setPendingBoundaryEditConfirmation(null);
    await handleSend({ ...pendingOverrides, skipBoundaryEditConfirmation: true });
  };

  const handleBoundaryEditCancel = () => {
    setPendingBoundaryEditConfirmation(null);
  };

  // Keep the imperative API pointing at the latest send handler.
  handleSendRef.current = handleSend;

  // Handler for Escape in vim normal mode - cancels edit if editing
  const handleEscapeInNormalMode = () => {
    if (variant === "workspace" && editingMessageForUi && props.onCancelEdit) {
      restorePreEditDraft();
      props.onCancelEdit();
      inputRef.current?.blur();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle voice input toggle (Ctrl+D / Cmd+D)
    if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT) && voiceInput.shouldShowUI) {
      e.preventDefault();
      if (!voiceInput.isAvailable) {
        pushToast({
          type: "error",
          message: voiceInputUnavailableMessage,
        });
        return;
      }
      voiceInput.toggle();
      return;
    }

    // Space on empty input starts voice recording (ignore key repeat from holding)
    if (
      e.key === " " &&
      !e.repeat &&
      input.trim() === "" &&
      voiceInput.shouldShowUI &&
      voiceInput.isAvailable &&
      voiceInput.state === "idle"
    ) {
      e.preventDefault();
      voiceInput.start();
      return;
    }

    // Cycle models (Ctrl+/)
    if (matchesKeybind(e, KEYBINDS.CYCLE_MODEL)) {
      e.preventDefault();
      cycleToNextModel();
      return;
    }

    // Handle cancel edit (Escape) - workspace only
    // In vim mode, escape first goes to normal mode; escapeInNormalMode callback handles cancel
    // In non-vim mode, escape directly cancels edit
    if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
      if (variant === "workspace" && editingMessageForUi && props.onCancelEdit && !vimEnabled) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        restorePreEditDraft();
        props.onCancelEdit();
        const isFocused = document.activeElement === inputRef.current;
        if (isFocused) {
          inputRef.current?.blur();
        }
        return;
      }
    }

    // Handle up arrow on empty input - edit last user message (workspace only)
    if (
      variant === "workspace" &&
      e.key === "ArrowUp" &&
      !editingMessageForUi &&
      input.trim() === "" &&
      props.onEditLastUserMessage
    ) {
      e.preventDefault();
      props.onEditLastUserMessage();
      return;
    }

    // Note: ESC handled by VimTextArea (for mode transitions) and CommandSuggestions (for dismissal)

    const hasCommandSuggestionMenu =
      suggestionMenus.command.show && suggestionMenus.command.suggestions.length > 0;
    const hasAtMentionSuggestionMenu =
      suggestionMenus.atMention.show && suggestionMenus.atMention.suggestions.length > 0;
    const hasSkillSuggestionMenu =
      suggestionMenus.skill.show && suggestionMenus.skill.suggestions.length > 0;
    const hasSymbolSuggestionMenu =
      suggestionMenus.symbol.show && suggestionMenus.symbol.suggestions.length > 0;

    // Don't handle keys if suggestions are visible.
    // Enter/Tab/arrows/Escape are handled by CommandSuggestions for slash, @file, $skill, and \symbol menus.
    if (
      (hasCommandSuggestionMenu && COMMAND_SUGGESTION_KEYS.includes(e.key)) ||
      (hasAtMentionSuggestionMenu && FILE_SUGGESTION_KEYS.includes(e.key)) ||
      (hasSkillSuggestionMenu && FILE_SUGGESTION_KEYS.includes(e.key)) ||
      (hasSymbolSuggestionMenu && FILE_SUGGESTION_KEYS.includes(e.key))
    ) {
      return; // Let CommandSuggestions handle it
    }

    // Handle send message (Shift+Enter for newline is default behavior)
    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE_AFTER_TURN)) {
      e.preventDefault();
      void handleSend({ queueDispatchMode: "turn-end" });
      return;
    }

    if (matchesKeybind(e, KEYBINDS.SEND_MESSAGE)) {
      // Mobile keyboards should keep Enter for newlines; sending remains button-driven.
      if (isMobileTouch) {
        return;
      }
      if (
        variant === "workspace" &&
        !e.repeat &&
        !editingMessageForUi &&
        props.queuedMessage != null &&
        props.onSendQueuedImmediately &&
        input.trim() === "" &&
        attachments.length === 0 &&
        reviewPanelItems.length === 0
      ) {
        // User request: with an already-queued follow-up and an empty composer, Enter
        // should activate the visible "Send now" action instead of requiring a mouse click.
        e.preventDefault();
        e.stopPropagation();
        void props.onSendQueuedImmediately();
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  };

  const interruptKeybind = vimEnabled
    ? KEYBINDS.INTERRUPT_STREAM_VIM
    : KEYBINDS.INTERRUPT_STREAM_NORMAL;

  // Build placeholder text based on current state
  const placeholder = (() => {
    // Creation view keeps the onboarding prompt; workspace stays concise for the inline hints.
    if (variant === "creation") {
      return "Type your first message to create a workspace...";
    }

    // Workspace variant placeholders
    if (editingMessageForUi) {
      if (isMobileTouch) {
        return "Edit your message...";
      }
      const cancelHint = vimEnabled
        ? `${formatKeybind(KEYBINDS.CANCEL_EDIT)}×2 to cancel`
        : `${formatKeybind(KEYBINDS.CANCEL_EDIT)} to cancel`;
      return `Edit your message... (${cancelHint}, ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to send)`;
    }
    if (disabled) {
      const disabledReason = props.disabledReason;
      if (typeof disabledReason === "string" && disabledReason.trim().length > 0) {
        return disabledReason;
      }
    }
    if (isCompacting) {
      if (isMobileTouch) {
        return "Compacting...";
      }
      return `Compacting... (${formatKeybind(interruptKeybind)} cancel | ${formatKeybind(KEYBINDS.SEND_MESSAGE)} to queue)`;
    }

    // Tip carousel: rotates the placeholder through a curated list of
    // slash-command tricks on a wall-clock bucket so switching workspaces
    // mid-bucket doesn't reroll the visible tip. See placeholderTips.ts.
    //
    // Mobile gets the plain placeholder because the on-screen keyboard already
    // squeezes the input and a long English sentence in the placeholder looks
    // like a wall of grey text instead of a hint.
    if (isMobileTouch) {
      return "Type a message...";
    }
    return getPlaceholderTip();
  })();

  const activeToast = toast ?? (variant === "creation" ? creationState.toast : null);

  // No wrapper needed - parent controls layout for both variants
  const Wrapper = React.Fragment;
  const wrapperProps = {};

  return (
    <Wrapper {...wrapperProps}>
      {creationState.trustDialog}
      {/* Loading overlay during workspace creation */}
      {variant === "creation" && (
        <CreationCenterContent
          projectName={props.projectName}
          isSending={isSendInFlight}
          workspaceName={isSendInFlight ? creationState.creatingWithIdentity?.name : undefined}
          workspaceTitle={isSendInFlight ? creationState.creatingWithIdentity?.title : undefined}
        />
      )}

      {/* Input section - centered card for creation, bottom bar for workspace */}
      <div
        ref={chatInputSectionRef}
        className={cn(
          "relative flex flex-col gap-1",
          variant === "creation"
            ? "bg-surface-primary w-full max-w-3xl rounded-lg border border-border-light px-6 py-5 shadow-lg"
            : `bg-surface-primary border-border-light px-4 
              pb-[max(8px,min(env(safe-area-inset-bottom,0px),40px))] 
              mb-[calc(-1*min(env(safe-area-inset-bottom,0px),40px))]`
        )}
        data-component="ChatInputSection"
        data-autofocus-state="done"
      >
        <div className={cn("w-full", variant !== "creation" && "mx-auto max-w-4xl")}>
          {/* Toasts (overlay) */}
          <div className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 flex flex-col gap-2 [&>*]:pointer-events-auto">
            <ConnectionStatusToast wrap={false} />
            <ChatInputToast
              toast={activeToast}
              wrap={false}
              onDismiss={() => {
                handleToastDismiss();
                if (variant === "creation") {
                  creationState.setToast(null);
                }
              }}
            />
          </div>

          {/* Attached reviews preview - show styled blocks with remove/edit buttons */}
          {/* Hide during send to avoid duplicate display with the sent message */}
          {variant === "workspace" && !hideReviewsDuringSend && (
            <AttachedReviewsPanel
              reviews={reviewPanelItems}
              onDetachAll={
                reviewOverrideActive
                  ? () =>
                      setDraftReviews((prev) => (prev === null || prev.length === 0 ? prev : []))
                  : props.onDetachAllReviews
              }
              onDetach={reviewOverrideActive ? removeDraftReview : props.onDetachReview}
              onCheck={reviewOverrideActive ? removeDraftReview : props.onCheckReview}
              onDelete={reviewOverrideActive ? removeDraftReview : props.onDeleteReview}
              onUpdateNote={reviewOverrideActive ? updateDraftReviewNote : props.onUpdateReviewNote}
            />
          )}

          {/* Creation header controls - shown above textarea for creation variant */}
          {creationControlsProps && <CreationControls {...creationControlsProps} />}

          <CodexOauthWarningBanner
            requiresCodexOauth={requiresCodexOauth(baseModel)}
            codexOauthSet={codexOauthSet}
            onOpenProviders={() => open("providers", { expandProvider: "openai" })}
          />

          {/* File path suggestions (@src/foo.ts) */}
          <CommandSuggestions
            suggestions={suggestionMenus.atMention.suggestions}
            onSelectSuggestion={suggestionMenus.handleAtMentionSelect}
            onDismiss={suggestionMenus.atMention.dismiss}
            isVisible={suggestionMenus.atMention.show}
            ariaLabel="File path suggestions"
            listId={suggestionMenus.atMention.listId}
            anchorRef={variant === "creation" ? inputRef : undefined}
            highlightQuery={suggestionMenus.atMention.highlightQuery}
            isFileSuggestion
          />

          {/* Skill suggestions ($deep-review) */}
          <CommandSuggestions
            suggestions={suggestionMenus.skill.suggestions}
            onSelectSuggestion={suggestionMenus.handleSkillSelect}
            onDismiss={suggestionMenus.skill.dismiss}
            isVisible={suggestionMenus.skill.show}
            ariaLabel="Skill suggestions"
            listId={suggestionMenus.skill.listId}
            anchorRef={variant === "creation" ? inputRef : undefined}
            highlightQuery={suggestionMenus.skill.highlightQuery}
          />

          {/* Slash command suggestions - available in both variants */}
          {/* In creation mode, use portal (anchorRef) to escape overflow:hidden containers */}
          <CommandSuggestions
            suggestions={suggestionMenus.command.suggestions}
            onSelectSuggestion={suggestionMenus.handleCommandSelect}
            onDismiss={suggestionMenus.command.dismiss}
            isVisible={suggestionMenus.command.show}
            ariaLabel="Slash command suggestions"
            listId={suggestionMenus.command.listId}
            anchorRef={variant === "creation" ? inputRef : undefined}
          />

          {/* Symbol shortcut suggestions (\alpha -> α, \leq -> ≤, \euro -> €) */}
          <CommandSuggestions
            suggestions={suggestionMenus.symbol.suggestions}
            onSelectSuggestion={suggestionMenus.handleSymbolSelect}
            onDismiss={suggestionMenus.symbol.dismiss}
            isVisible={suggestionMenus.symbol.show}
            ariaLabel="Symbol shortcuts"
            listId={suggestionMenus.symbol.listId}
            anchorRef={variant === "creation" ? inputRef : undefined}
            highlightQuery={suggestionMenus.symbol.highlightQuery}
          />

          <div className="relative flex items-end pb-1" data-component="ChatInputControls">
            {/* Recording/transcribing overlay - replaces textarea when active */}
            {voiceInput.state !== "idle" ? (
              <RecordingOverlay
                state={voiceInput.state}
                agentColor={focusBorderColor}
                mediaRecorder={voiceInput.mediaRecorder}
                onStop={voiceInput.toggle}
              />
            ) : (
              <>
                {/* Give the input more vertical room so the shortcut hints sit above the footer. */}
                <VimTextArea
                  ref={inputRef}
                  data-escape-interrupts-stream="true"
                  value={input}
                  ghostHint={suggestionMenus.command.ghostHint}
                  isEditing={!!editingMessageForUi}
                  focusBorderColor={focusBorderColor}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onKeyUp={suggestionMenus.handleCursorActivity}
                  onMouseUp={suggestionMenus.handleCursorActivity}
                  onSelect={suggestionMenus.handleCursorActivity}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onEscapeInNormalMode={handleEscapeInNormalMode}
                  suppressKeys={
                    suggestionMenus.atMention.show
                      ? FILE_SUGGESTION_KEYS
                      : suggestionMenus.skill.show
                        ? FILE_SUGGESTION_KEYS
                        : suggestionMenus.symbol.show
                          ? FILE_SUGGESTION_KEYS
                          : suggestionMenus.command.show
                            ? COMMAND_SUGGESTION_KEYS
                            : undefined
                  }
                  placeholder={placeholder}
                  disabled={!editingMessageForUi && (disabled || sendInFlightBlocksInput)}
                  aria-label={editingMessageForUi ? "Edit your last message" : "Message Claude"}
                  aria-autocomplete="list"
                  aria-controls={
                    suggestionMenus.atMention.show &&
                    suggestionMenus.atMention.suggestions.length > 0
                      ? suggestionMenus.atMention.listId
                      : suggestionMenus.skill.show && suggestionMenus.skill.suggestions.length > 0
                        ? suggestionMenus.skill.listId
                        : suggestionMenus.symbol.show &&
                            suggestionMenus.symbol.suggestions.length > 0
                          ? suggestionMenus.symbol.listId
                          : suggestionMenus.command.show &&
                              suggestionMenus.command.suggestions.length > 0
                            ? suggestionMenus.command.listId
                            : undefined
                  }
                  aria-expanded={
                    (suggestionMenus.command.show &&
                      suggestionMenus.command.suggestions.length > 0) ||
                    (suggestionMenus.atMention.show &&
                      suggestionMenus.atMention.suggestions.length > 0) ||
                    (suggestionMenus.skill.show && suggestionMenus.skill.suggestions.length > 0) ||
                    (suggestionMenus.symbol.show && suggestionMenus.symbol.suggestions.length > 0)
                  }
                  className={variant === "creation" ? "min-h-28" : "min-h-16"}
                />
                {/* Keep shortcuts visible in both creation + workspace without bloating the footer or crowding it. */}
                {input.trim() === "" && !editingMessageForUi && (
                  <div className="mobile-hide-shortcut-hints text-muted @container pointer-events-none absolute right-2 bottom-3 left-2 flex flex-nowrap items-center gap-4 overflow-hidden text-[11px] whitespace-nowrap">
                    <span className="shrink-0">
                      <span className="font-mono">{formatKeybind(KEYBINDS.FOCUS_CHAT)}</span>
                      <span> - focus chat</span>
                    </span>
                    <span className="shrink-0 [@container(max-width:520px)]:hidden">
                      <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_MODEL)}</span>
                      <span> - change model</span>
                    </span>
                    <span className="shrink-0 [@container(max-width:640px)]:hidden">
                      <span className="font-mono">{formatKeybind(KEYBINDS.CYCLE_AGENT)}</span>
                      <span> - change agent</span>
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Attachments */}
          <ChatAttachments attachments={attachments} onRemove={handleRemoveAttachment} />

          <div className="flex flex-col gap-0.5" data-component="ChatModeToggles">
            {/* Editing indicator - workspace only */}
            {variant === "workspace" && editingMessageForUi && (
              <div className="text-edit-mode text-[11px] font-medium">
                Editing message{" "}
                <span className="mobile-hide-shortcut-hints">
                  ({formatKeybind(KEYBINDS.CANCEL_EDIT)}
                  {vimEnabled ? "×2" : ""} to cancel)
                </span>
              </div>
            )}

            <div className="@container flex min-w-[340px] flex-nowrap items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <div
                  className="flex min-w-0 items-center gap-1.5"
                  data-component="ModelSelectorGroup"
                  data-tutorial="model-selector"
                >
                  <ModelSelector
                    ref={modelSelectorRef}
                    value={baseModel}
                    onChange={setPreferredModel}
                    models={models}
                    onComplete={() => inputRef.current?.focus()}
                    defaultModel={defaultModel}
                    onSetDefaultModel={setDefaultModel}
                    hiddenModels={hiddenModelsForSelector}
                    onOpenSettings={() => open("models")}
                    className="w-[clamp(5.5rem,28vw,8rem)] min-w-0"
                    tooltipExtraContent={
                      <>
                        <strong>Click to edit</strong>
                        <br />
                        <strong>{formatKeybind(KEYBINDS.CYCLE_MODEL)}</strong> to cycle models
                        <br />
                        <br />
                        <strong>Abbreviations:</strong>
                        {MODEL_ABBREVIATION_EXAMPLES.map((ex) => (
                          <React.Fragment key={ex.abbrev}>
                            <br />• <code>/model {ex.abbrev}</code> - {ex.displayName}
                          </React.Fragment>
                        ))}
                        <br />
                        <br />
                        <strong>Full format:</strong>
                        <br />
                        <code>/model provider:model-name</code>
                        <br />
                        (e.g., <code>/model anthropic:claude-sonnet-4-5</code>)
                      </>
                    }
                  />
                </div>

                {/* On narrow layouts, hide the thinking paddles to prevent control overlap. */}
                <div
                  className="flex shrink-0 items-center [@container(max-width:420px)]:[&_[data-thinking-paddle]]:hidden"
                  data-component="ThinkingSliderGroup"
                >
                  <ThinkingSliderComponent modelString={baseModel} />
                </div>
              </div>

              <div
                className="flex min-w-0 items-center justify-end gap-1.5"
                data-component="ModelControls"
                data-tutorial="mode-selector"
              >
                {variant === "workspace" && (
                  <ContextUsageIndicatorButton
                    data={contextUsageData}
                    autoCompaction={autoCompactionProps}
                    idleCompaction={idleCompactionProps}
                    model={contextDisplayModel}
                  />
                )}

                <div className="min-w-0 [@container(max-width:340px)]:hidden">
                  <AgentModePicker
                    className="min-w-0"
                    onComplete={() => inputRef.current?.focus()}
                  />
                </div>

                {/*
                  Input-method icons (attach, voice) cluster tightly with the Send button so
                  the trailing actions read as one unit, rather than as small icons stranded
                  inside the row's gap-1.5 cadence. They live below the textarea (not as an
                  absolute overlay) so they can never visually intersect typed/wrapped text.
                */}
                <div className="flex shrink-0 items-center gap-0" data-component="InputMethodGroup">
                  <AttachFileButton
                    onFiles={handleAttachFiles}
                    disabled={disabled || sendInFlightBlocksInput || !!editingMessageForUi}
                  />
                  <VoiceInputButton
                    state={voiceInput.state}
                    isAvailable={voiceInput.isAvailable}
                    shouldShowUI={voiceInput.shouldShowUI}
                    requiresSecureContext={voiceInput.requiresSecureContext}
                    onToggle={voiceInput.toggle}
                    disabled={disabled || sendInFlightBlocksInput}
                    agentColor={focusBorderColor}
                  />
                </div>

                {/*
                  Pull the Send button flush against the input-method icons (override the
                  parent's gap-1.5 with a negative margin) so they form a single trailing
                  cluster.
                */}
                <SendButton
                  canSend={canSend}
                  canChooseDispatchMode={canChooseDispatchMode}
                  onSend={(o) => void handleSend(o)}
                  variant={variant}
                  editingMessageForUi={editingMessageForUi}
                  runningGoalActive={runningGoalActive}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={pendingBoundaryEditConfirmation !== null}
        title="Edit Message Before Context Boundary?"
        description="Sending this edit will discard the latest compaction or reset summary and every message after the edited one, then continue from the rewritten history."
        warning="This action cannot be undone."
        confirmLabel="Edit and Send"
        onConfirm={handleBoundaryEditConfirm}
        onCancel={handleBoundaryEditCancel}
      />

      {/* Confirmation modal for destructive commands (currently only /clear). */}
      <ConfirmationModal
        isOpen={pendingDestructiveCommand}
        title="Clear Chat History?"
        description="This will remove all messages from the conversation."
        warning="This action cannot be undone."
        confirmLabel="Clear"
        onConfirm={handleDestructiveCommandConfirm}
        onCancel={handleDestructiveCommandCancel}
      />
    </Wrapper>
  );
};

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";
