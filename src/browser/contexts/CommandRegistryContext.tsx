import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

import { usePersistedState } from "@/browser/hooks/usePersistedState";

export interface CommandAction {
  id: string;
  title: string;
  subtitle?: string;
  section: string; // grouping label
  keywords?: string[];
  shortcutHint?: string; // display-only hint (e.g., ⌘P)
  icon?: React.ReactNode;
  visible?: () => boolean;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
  prompt?: {
    title?: string;
    fields: Array<
      | {
          type: "text";
          name: string;
          label?: string;
          placeholder?: string;
          initialValue?: string;
          getInitialValue?: (values: Record<string, string>) => string;
          validate?: (v: string) => string | null;
        }
      | {
          type: "select";
          name: string;
          label?: string;
          placeholder?: string;
          getOptions: (values: Record<string, string>) =>
            | Array<{
                id: string;
                label: string;
                keywords?: string[];
              }>
            | Promise<
                Array<{
                  id: string;
                  label: string;
                  keywords?: string[];
                }>
              >;
        }
    >;
    onSubmit: (values: Record<string, string>) => void | Promise<void>;
  };
}

export type CommandSource = () => CommandAction[];

interface CommandRegistryContextValue {
  isOpen: boolean;
  initialQuery: string;
  open: (initialQuery?: string) => void;
  close: () => void;
  registerSource: (source: CommandSource) => () => void;
  getActions: () => CommandAction[];
  addRecent: (actionId: string) => void;
  recent: string[];
}

const CommandRegistryContext = createContext<CommandRegistryContextValue | null>(null);

export function useOptionalCommandRegistry(): CommandRegistryContextValue | null {
  return useContext(CommandRegistryContext);
}

export function useCommandRegistry(): CommandRegistryContextValue {
  const ctx = useContext(CommandRegistryContext);
  if (!ctx) throw new Error("useCommandRegistry must be used within CommandRegistryProvider");
  return ctx;
}

const RECENT_STORAGE_KEY = "commandPalette:recent";
const MAX_RECENT_ACTIONS = 20;

function normalizeRecentActionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT_ACTIONS);
}

export const CommandRegistryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [sources, setSources] = useState<Set<CommandSource>>(new Set());
  const [storedRecent, setStoredRecent] = usePersistedState<string[]>(RECENT_STORAGE_KEY, [], {
    listener: true,
  });
  const recent = useMemo(() => normalizeRecentActionIds(storedRecent), [storedRecent]);

  const addRecent = useCallback(
    (actionId: string) => {
      // Use a functional persisted update so back-to-back command runs cannot
      // clobber each other by closing over stale recent state.
      setStoredRecent((prev) => {
        const normalizedPrev = normalizeRecentActionIds(prev);
        return normalizeRecentActionIds([
          actionId,
          ...normalizedPrev.filter((id) => id !== actionId),
        ]);
      });
    },
    [setStoredRecent]
  );

  const open = useCallback((query?: string) => {
    setInitialQuery(query ?? "");
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  const registerSource = useCallback((source: CommandSource) => {
    setSources((prev) => new Set(prev).add(source));
    return () =>
      setSources((prev) => {
        const copy = new Set(prev);
        copy.delete(source);
        return copy;
      });
  }, []);

  const getActions = useCallback(() => {
    const all: CommandAction[] = [];
    for (const s of sources) {
      try {
        const actions = s();
        for (const a of actions) {
          if (a.visible && !a.visible()) continue;
          all.push(a);
        }
      } catch (e) {
        console.error("Command source error:", e);
      }
    }
    return all;
  }, [sources]);

  const value = useMemo(
    () => ({
      isOpen,
      initialQuery,
      open,
      close,
      registerSource,
      getActions,
      addRecent,
      recent,
    }),
    [isOpen, initialQuery, open, close, registerSource, getActions, addRecent, recent]
  );

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  );
};
