import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/suggestions";
import type { ExperimentId } from "@/common/constants/experiments";
import { findAtMentionAtCursor } from "@/common/utils/atMentions";
import { findInlineSkillReferenceAtCursor } from "@/browser/utils/agentSkills/inlineSkillReferences";
import {
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";
import {
  getInlineSkillInsertionTrailingText,
  getInlineSkillSuggestions,
  shouldRefreshInlineSkillSuggestions,
} from "@/browser/utils/agentSkills/inlineSkillSuggestions";
import { getCommandGhostHint } from "@/browser/utils/slashCommands/registry";
import {
  getSlashCommandSuggestions,
} from "@/browser/utils/slashCommands/suggestions";
import { resolveSlashCommandExperimentValue } from "@/browser/utils/slashCommands/experimentVisibility";

// Reuse empty-array stable references so suggestion effects do not schedule
// an avoidable second render on every keypress.
function clearSuggestions(prev: SlashSuggestion[]): SlashSuggestion[] {
  return prev.length === 0 ? prev : [];
}

function replaceSuggestions(prev: SlashSuggestion[], next: SlashSuggestion[]): SlashSuggestion[] {
  return prev.length === 0 && next.length === 0 ? prev : next;
}

export interface SuggestionMenusConfig {
  input: string;
  setInput: (next: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  api: APIClient | null;
  variant: "workspace" | "creation";
  workspaceId: string | null;
  projectPath: string | undefined;
  agentSkillDescriptors: AgentSkillDescriptor[];
  experiments: {
    workspaceHeartbeats: boolean;
    dynamicWorkflows: boolean;
    memory: boolean;
    memoryConsolidation: boolean;
  };
}

export interface SuggestionMenusResult {
  // Visibility + suggestion data for each menu
  atMention: {
    show: boolean;
    suggestions: SlashSuggestion[];
    listId: string;
    dismiss: () => void;
    highlightQuery: string;
  };
  skill: {
    show: boolean;
    suggestions: SlashSuggestion[];
    listId: string;
    dismiss: () => void;
    highlightQuery: string;
  };
  command: {
    show: boolean;
    suggestions: SlashSuggestion[];
    listId: string;
    dismiss: () => void;
    ghostHint: ReturnType<typeof getCommandGhostHint>;
  };
  symbol: {
    show: boolean;
    suggestions: SlashSuggestion[];
    listId: string;
    dismiss: () => void;
    highlightQuery: string;
  };

  // Selection handlers
  handleAtMentionSelect: (suggestion: SlashSuggestion) => void;
  handleSkillSelect: (suggestion: SlashSuggestion) => void;
  handleCommandSelect: (suggestion: SlashSuggestion) => void;
  handleSymbolSelect: (suggestion: SlashSuggestion) => void;

  // Cursor activity listener (attach to textarea onSelect/onKeyUp/onMouseUp)
  handleCursorActivity: () => void;
}

/**
 * Consolidates the 4 parallel suggestion systems (@file, $skill, /slash, \symbol)
 * that watch input/cursor position and surface autocomplete menus.
 *
 * Extracted from ChatInput/index.tsx to isolate suggestion state management and
 * effects from the main component's render path.
 */
export function useSuggestionMenus(config: SuggestionMenusConfig): SuggestionMenusResult {
  const {
    input,
    setInput,
    inputRef,
    api,
    variant,
    workspaceId,
    projectPath,
    agentSkillDescriptors,
    experiments,
  } = config;

  // ----- State -----
  const [showAtMentionSuggestions, setShowAtMentionSuggestions] = useState(false);
  const [atMentionSuggestions, setAtMentionSuggestions] = useState<SlashSuggestion[]>([]);
  const [showSkillSuggestions, setShowSkillSuggestions] = useState(false);
  const [skillSuggestions, setSkillSuggestions] = useState<SlashSuggestion[]>([]);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [commandSuggestions, setCommandSuggestions] = useState<SlashSuggestion[]>([]);
  const [showSymbolSuggestions, setShowSymbolSuggestions] = useState(false);
  const [symbolSuggestions, setSymbolSuggestions] = useState<SlashSuggestion[]>([]);

  // ----- Refs -----
  const atMentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atMentionRequestIdRef = useRef(0);
  const lastAtMentionScopeIdRef = useRef<string | null>(null);
  const lastAtMentionQueryRef = useRef<string | null>(null);
  const lastAtMentionInputRef = useRef<string>(input);
  const lastSkillInputRef = useRef<string | null>(null);
  const lastSkillQueryRef = useRef<string | null>(null);
  const lastSkillDescriptorsRef = useRef<AgentSkillDescriptor[] | null>(null);
  const lastSymbolQueryRef = useRef<string>("");

  // ----- Cursor tracking -----
  const [atMentionCursorNonce, setAtMentionCursorNonce] = useState(0);
  const lastAtMentionCursorRef = useRef<number | null>(null);

  const handleCursorActivity = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }

    const nextCursor = el.selectionStart ?? input.length;
    if (lastAtMentionCursorRef.current === nextCursor) {
      return;
    }

    lastAtMentionCursorRef.current = nextCursor;
    setAtMentionCursorNonce((n) => n + 1);
  }, [input.length, inputRef]);

  // ----- List IDs -----
  const atMentionListId = useId();
  const skillListId = useId();
  const commandListId = useId();
  const symbolListId = useId();

  // ----- @file mention effect -----
  useEffect(() => {
    if (atMentionDebounceRef.current) {
      clearTimeout(atMentionDebounceRef.current);
      atMentionDebounceRef.current = null;
    }

    const inputChanged = lastAtMentionInputRef.current !== input;
    lastAtMentionInputRef.current = input;

    const atMentionScopeId = variant === "workspace" ? workspaceId : projectPath;

    if (!api || !atMentionScopeId) {
      atMentionRequestIdRef.current++;
      lastAtMentionScopeIdRef.current = null;
      lastAtMentionQueryRef.current = null;
      setAtMentionSuggestions(clearSuggestions);
      setShowAtMentionSuggestions(false);
      return;
    }

    const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
    const match = findAtMentionAtCursor(input, cursor);

    if (!match) {
      atMentionRequestIdRef.current++;
      lastAtMentionScopeIdRef.current = null;
      lastAtMentionQueryRef.current = null;
      setAtMentionSuggestions(clearSuggestions);
      setShowAtMentionSuggestions(false);
      return;
    }

    if (!inputChanged && !showAtMentionSuggestions) {
      return;
    }

    if (
      !inputChanged &&
      lastAtMentionScopeIdRef.current === atMentionScopeId &&
      lastAtMentionQueryRef.current === match.query
    ) {
      return;
    }

    lastAtMentionScopeIdRef.current = atMentionScopeId;
    lastAtMentionQueryRef.current = match.query;

    const requestId = ++atMentionRequestIdRef.current;
    const runRequest = () => {
      void (async () => {
        try {
          const result =
            variant === "workspace"
              ? await api.workspace.getFileCompletions({
                  workspaceId: atMentionScopeId,
                  query: match.query,
                  limit: 20,
                })
              : await api.projects.getFileCompletions({
                  projectPath: atMentionScopeId,
                  query: match.query,
                  limit: 20,
                });

          if (atMentionRequestIdRef.current !== requestId) {
            return;
          }

          const nextSuggestions = result.paths
            .filter((p) => !/\s/.test(p))
            .map((p) => {
              const getFileType = (path: string): string => {
                if (path.endsWith("/")) return "Directory";
                const lastDot = path.lastIndexOf(".");
                const lastSlash = path.lastIndexOf("/");
                if (lastDot > lastSlash && lastDot < path.length - 1) {
                  return path.slice(lastDot + 1).toUpperCase();
                }
                return "File";
              };
              return {
                id: `file:${p}`,
                display: p,
                description: getFileType(p),
                replacement: `@${p}`,
              };
            });

          setAtMentionSuggestions(nextSuggestions);
          setShowAtMentionSuggestions(nextSuggestions.length > 0);
        } catch {
          if (atMentionRequestIdRef.current === requestId) {
            setAtMentionSuggestions(clearSuggestions);
            setShowAtMentionSuggestions(false);
          }
        }
      })();
    };

    runRequest();
  }, [
    api,
    input,
    showAtMentionSuggestions,
    variant,
    workspaceId,
    projectPath,
    atMentionCursorNonce,
    inputRef,
  ]);

  // ----- $skill inline effect -----
  useEffect(() => {
    if (showAtMentionSuggestions) {
      setSkillSuggestions((prev) => (prev.length === 0 ? prev : []));
      setShowSkillSuggestions(false);
      lastSkillQueryRef.current = null;
      return;
    }

    const inputChanged = lastSkillInputRef.current !== input;
    lastSkillInputRef.current = input;

    const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
    const match = findInlineSkillReferenceAtCursor(input, cursor);

    if (!match) {
      setSkillSuggestions(clearSuggestions);
      setShowSkillSuggestions(false);
      lastSkillQueryRef.current = null;
      return;
    }

    if (
      !shouldRefreshInlineSkillSuggestions({
        inputChanged,
        previousPartial: lastSkillQueryRef.current,
        partial: match.partial,
        previousDescriptors: lastSkillDescriptorsRef.current,
        descriptors: agentSkillDescriptors,
      })
    ) {
      return;
    }

    lastSkillQueryRef.current = match.partial;

    const nextSuggestions = getInlineSkillSuggestions({
      partial: match.partial,
      descriptors: agentSkillDescriptors,
    });
    lastSkillDescriptorsRef.current = agentSkillDescriptors;
    setSkillSuggestions(nextSuggestions);
    setShowSkillSuggestions(nextSuggestions.length > 0);
  }, [input, showAtMentionSuggestions, agentSkillDescriptors, atMentionCursorNonce, inputRef]);

  // ----- /slash command effect -----
  useLayoutEffect(() => {
    const suggestions = getSlashCommandSuggestions(input, {
      agentSkills: agentSkillDescriptors,
      variant,
      isExperimentEnabled: (experimentId: ExperimentId) =>
        resolveSlashCommandExperimentValue(experimentId, {
          workspaceHeartbeats: experiments.workspaceHeartbeats,
          dynamicWorkflows: experiments.dynamicWorkflows,
          memory: experiments.memory,
          memoryConsolidation: experiments.memoryConsolidation,
        }),
    });
    setCommandSuggestions((prev) => replaceSuggestions(prev, suggestions));
    setShowCommandSuggestions(suggestions.length > 0);
  }, [
    input,
    agentSkillDescriptors,
    variant,
    experiments.workspaceHeartbeats,
    experiments.dynamicWorkflows,
    experiments.memory,
    experiments.memoryConsolidation,
  ]);

  // ----- \symbol effect -----
  useLayoutEffect(() => {
    if (showAtMentionSuggestions) {
      setSymbolSuggestions(clearSuggestions);
      setShowSymbolSuggestions(false);
      return;
    }

    const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
    const match = findSymbolCommandAtCursor(input, cursor);
    if (!match) {
      setSymbolSuggestions(clearSuggestions);
      setShowSymbolSuggestions(false);
      return;
    }

    const suggestions = getSymbolSuggestions(match.partial);
    lastSymbolQueryRef.current = match.partial;
    setSymbolSuggestions((prev) => replaceSuggestions(prev, suggestions));
    setShowSymbolSuggestions(suggestions.length > 0);
  }, [input, showAtMentionSuggestions, atMentionCursorNonce, inputRef]);

  // ----- Ghost hint -----
  const commandGhostHint = getCommandGhostHint(input, showCommandSuggestions, {
    variant,
    isExperimentEnabled: (experimentId: ExperimentId) =>
      resolveSlashCommandExperimentValue(experimentId, {
        workspaceHeartbeats: experiments.workspaceHeartbeats,
        dynamicWorkflows: experiments.dynamicWorkflows,
        memory: experiments.memory,
        memoryConsolidation: experiments.memoryConsolidation,
      }),
  });

  // ----- Selection handlers -----
  const handleAtMentionSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
      const match = findAtMentionAtCursor(input, cursor);
      if (!match) {
        return;
      }

      const next =
        input.slice(0, match.startIndex) +
        suggestion.replacement +
        " " +
        input.slice(match.endIndex);

      setInput(next);
      setAtMentionSuggestions(clearSuggestions);
      setShowAtMentionSuggestions(false);

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.disabled) {
          return;
        }

        el.focus();
        const newCursor = match.startIndex + suggestion.replacement.length + 1;
        el.selectionStart = newCursor;
        el.selectionEnd = newCursor;
      });
    },
    [input, setInput, inputRef]
  );

  const handleSkillSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
      const match = findInlineSkillReferenceAtCursor(input, cursor);
      if (!match) {
        return;
      }

      const after = input.slice(match.endIndex);
      const trailing = getInlineSkillInsertionTrailingText(after);
      const next = input.slice(0, match.startIndex) + suggestion.replacement + trailing + after;

      setInput(next);
      setSkillSuggestions(clearSuggestions);
      setShowSkillSuggestions(false);
      lastSkillQueryRef.current = null;

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.disabled) {
          return;
        }

        el.focus();
        const newCursor = match.startIndex + suggestion.replacement.length + trailing.length;
        el.selectionStart = newCursor;
        el.selectionEnd = newCursor;
      });
    },
    [input, setInput, inputRef]
  );

  const handleCommandSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      setInput(suggestion.replacement);
      setShowCommandSuggestions(false);
      inputRef.current?.focus();
    },
    [setInput, inputRef]
  );

  const handleSymbolSelect = useCallback(
    (suggestion: SlashSuggestion) => {
      const cursor = Math.min(inputRef.current?.selectionStart ?? input.length, input.length);
      const match = findSymbolCommandAtCursor(input, cursor);
      if (!match) {
        return;
      }

      const next =
        input.slice(0, match.startIndex) + suggestion.replacement + input.slice(match.endIndex);

      setInput(next);
      setSymbolSuggestions(clearSuggestions);
      setShowSymbolSuggestions(false);

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.disabled) {
          return;
        }

        el.focus();
        const newCursor = match.startIndex + suggestion.replacement.length;
        el.selectionStart = newCursor;
        el.selectionEnd = newCursor;
      });
    },
    [input, setInput, inputRef]
  );

  return {
    atMention: {
      show: showAtMentionSuggestions,
      suggestions: atMentionSuggestions,
      listId: atMentionListId,
      dismiss: () => setShowAtMentionSuggestions(false),
      highlightQuery: lastAtMentionQueryRef.current ?? "",
    },
    skill: {
      show: showSkillSuggestions,
      suggestions: skillSuggestions,
      listId: skillListId,
      dismiss: () => setShowSkillSuggestions(false),
      highlightQuery: lastSkillQueryRef.current ?? "",
    },
    command: {
      show: showCommandSuggestions,
      suggestions: commandSuggestions,
      listId: commandListId,
      dismiss: () => setShowCommandSuggestions(false),
      ghostHint: commandGhostHint,
    },
    symbol: {
      show: showSymbolSuggestions,
      suggestions: symbolSuggestions,
      listId: symbolListId,
      dismiss: () => setShowSymbolSuggestions(false),
      highlightQuery: lastSymbolQueryRef.current,
    },
    handleAtMentionSelect,
    handleSkillSelect,
    handleCommandSelect,
    handleSymbolSelect,
    handleCursorActivity,
  };
}
