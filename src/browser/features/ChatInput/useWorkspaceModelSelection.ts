import { useCallback, useEffect, useRef } from "react";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import {
  updatePersistedState,
  readPersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import type { APIClient } from "@/browser/contexts/API";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { Toast } from "./ChatInputToast";
import {
  getThinkingLevelKey,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
  getProjectScopeId,
  AGENT_AI_DEFAULTS_KEY,
} from "@/common/constants/storage";
import {
  markPendingWorkspaceAiSettings,
  clearPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";

type GoalBudgetState = Parameters<typeof hasBudgetedResumableGoal>[0];

export interface WorkspaceModelSelectionConfig {
  variant: "workspace" | "creation";
  workspaceId: string | null;
  agentId: string | null | undefined;
  thinkingLevel: ThinkingLevel;
  baseModel: string;
  models: string[];
  defaultModel: string;
  ensureModelInSettings: (model: string) => void;
  onModelChange: ((model: string) => void) | undefined;
  workspaceGoal: GoalBudgetState;
  providersConfig: ProvidersConfigMap | null;
  api: APIClient | null | undefined;
  creationParentProjectPath: string;
  setToast: React.Dispatch<React.SetStateAction<Toast | null>>;
}

export interface WorkspaceModelSelectionReturn {
  setPreferredModel: (model: string) => void;
  cycleToNextModel: () => void;
  agentAiDefaults: AgentAiDefaults;
}

export function useWorkspaceModelSelection(
  config: WorkspaceModelSelectionConfig
): WorkspaceModelSelectionReturn {
  const {
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
  } = config;

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    { listener: true }
  );

  const setPreferredModel = useCallback(
    (model: string) => {
      type WorkspaceAISettingsByAgentCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const selectedModel = normalizeSelectedModel(model);
      if (
        variant === "workspace" &&
        hasBudgetedResumableGoal(workspaceGoal) &&
        !modelHasPricingData(selectedModel, providersConfig)
      ) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
        });
        return;
      }

      ensureModelInSettings(selectedModel);

      if (onModelChange) {
        onModelChange(selectedModel);
      } else {
        const scopeId =
          variant === "creation" ? getProjectScopeId(creationParentProjectPath) : workspaceId;
        if (scopeId) {
          setWorkspaceModelWithOrigin(scopeId, selectedModel, "user");
        }
      }

      if (variant !== "workspace" || !workspaceId) {
        return;
      }

      const normalizedAgentId = normalizeAgentId(agentId, "exec");

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model: selectedModel, thinkingLevel },
          };
        },
        {}
      );

      if (!api) {
        return;
      }

      markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
        model: selectedModel,
        thinkingLevel,
      });

      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: normalizedAgentId,
          aiSettings: { model: selectedModel, thinkingLevel },
        })
        .then((result) => {
          if (!result.success) {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          }
        })
        .catch(() => {
          clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
        });
    },
    [
      api,
      agentId,
      creationParentProjectPath,
      ensureModelInSettings,
      providersConfig,
      onModelChange,
      thinkingLevel,
      variant,
      workspaceGoal,
      workspaceId,
      setToast,
    ]
  );

  const cycleToNextModel = useCallback(() => {
    if (models.length < 2) {
      return;
    }

    const currentIndex = models.indexOf(baseModel);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % models.length;
    const nextModel = models[nextIndex];
    if (nextModel) {
      setPreferredModel(nextModel);
    }
  }, [baseModel, models, setPreferredModel]);

  // Creation variant: keep the project-scoped model/thinking in sync with global agent defaults
  const prevCreationAgentIdRef = useRef<string | null>(null);
  const prevCreationScopeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (variant !== "creation") {
      prevCreationAgentIdRef.current = null;
      prevCreationScopeIdRef.current = null;
      return;
    }

    const scopeId = getProjectScopeId(creationParentProjectPath);
    const modelKey = getModelKey(scopeId);
    const thinkingKey = getThinkingLevelKey(scopeId);

    const fallbackModel = defaultModel;

    const normalizedAgentId = normalizeAgentId(agentId, "exec");

    const isExplicitAgentSwitch =
      prevCreationAgentIdRef.current !== null &&
      prevCreationScopeIdRef.current === scopeId &&
      prevCreationAgentIdRef.current !== normalizedAgentId;

    prevCreationAgentIdRef.current = normalizedAgentId;
    prevCreationScopeIdRef.current = scopeId;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel = agentAiDefaults[normalizedAgentId]?.modelString ?? existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      agentAiDefaults[normalizedAgentId]?.thinkingLevel ?? existingThinking ?? "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(scopeId, resolvedModel, isExplicitAgentSwitch ? "agent" : "sync");
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }
  }, [agentAiDefaults, agentId, creationParentProjectPath, defaultModel, variant]);

  return {
    setPreferredModel,
    cycleToNextModel,
    agentAiDefaults,
  };
}
