---
title: "Quick-Win Optimization Pass — Speed & Quality"
description: "What, why, where, and when for the renderer speed/quality audit: 8 completed slices, 4 planned quick wins, and deferred refactors. Covers rerender reduction, race fixes, and storage-churn elimination."
---

# Quick-Win Optimization Pass — Speed & Quality

> **Status:** 8 / 13 slices complete & validated · 4 quick wins planned · 4 large refactors deferred
> **Scope:** renderer speed (re-render reduction), correctness (race fixes), storage churn, security hardening
> **Principle:** smallest safe change per slice, validated in isolation (`bun test` + `make typecheck`) before moving on.

## TL;DR

An audit of the renderer surfaced a layered set of speed/quality wins. This document tracks the whole pass end-to-end. Eight slices are **done and validated** in the worktree (uncommitted). Four **quick wins remain** (mobile + Mermaid + workflow polling). Four **larger refactors** are explicitly deferred.

```mermaid
flowchart TD
    AUDIT["Quick-win audit<br/>(renderer)"] --> RACES["Race / correctness"]
    AUDIT --> RENDERS["Re-render reduction"]
    AUDIT --> STORAGE["Storage churn"]
    AUDIT --> SECURITY["Security hardening"]

    RACES --> D1["✅ workflow polling overlap"]
    RACES --> D2["✅ command palette lost-update"]
    RACES --> D3["✅ chatCommands rAF readiness"]
    RACES --> D4["⏳ mobile settings ordering"]

    RENDERS --> R1["✅ metadata selector hook"]
    RENDERS --> R2["✅ review actions split"]

    STORAGE --> S1["✅ sidebar resize commit-on-up"]
    STORAGE --> S2["✅ threshold slider commit-on-up"]
    STORAGE --> S3["⏳ workflow row polling cache"]

    SECURITY --> SE1["⏳ Mermaid dual sinks"]
    SECURITY --> SE2["⏸ auth token storage (deferred)"]
```

---

## 1. Why — Origin & motivation

The renderer is a React 18 + React Compiler app on an external-store pattern (`MapStore` → `WorkspaceStore`, ~22 fine-grained hooks). Two recurring patterns caused the bulk of the pain surfaced by the audit:

1. **Broad subscriptions.** Several hot components subscribed to a whole `Map` of workspace metadata (or the full review state) when they only needed one entry. Any metadata replacement re-rendered every consumer.
2. **Per-interaction churn.** Drag handles and polling loops wrote to `localStorage` / fired RPCs on every tick instead of committing once.

Both are invisible until load grows (large sidebar, deep workflow trees, fast dragging) — so they're high-ROI to fix early.

---

## 2. What & Where — Completed slices (Phase 0)

All eight are validated; diffs are in the worktree (uncommitted). +770 / −234 lines across 19 files.

| #  | Slice                          | Where (primary)                                              | Why                                                                                                              | Win                                    |
|----|--------------------------------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|----------------------------------------|
| 1  | Workflow polling overlap       | `src/browser/hooks/useWorkflowRunById.ts`                    | `setInterval` started a refresh even if the prior RPC was in flight → overlapping requests + out-of-order state. | Chained `setTimeout` + in-flight guard |
| 2  | Command palette persistence    | `src/browser/contexts/CommandRegistryContext.tsx`            | Raw `localStorage` + stale-closure `recent` update lost entries when two `addRecent` calls fired before re-render. | `usePersistedState` + functional update |
| 3  | Sidebar resize churn           | `src/browser/hooks/useResizableSidebar.ts`                   | Persisted width to `localStorage` on every `mousemove` of a drag.                                                | Commit on drag-end                     |
| 4  | chatCommands storage           | `src/browser/utils/chatCommands.ts`                          | Raw `localStorage.getItem` bypassed the shared self-healing helpers.                                             | `readPersistedString`                  |
| 5  | ThresholdSlider drag           | `src/browser/features/RightSidebar/ThresholdSlider.tsx`      | Each drag tick wrote persisted state **and** mirrored to `api.workspace.setAutoCompactionThreshold`.             | Preview local, commit on pointer-up    |
| 6  | Metadata selector hook         | `src/browser/stores/WorkspaceStore.ts` + 5 consumers         | Hot leaves subscribed to the full metadata `Map`; any replacement re-rendered them even when their entry didn't change. | New `useWorkspaceMetadataEntry` (per-workspace `useSyncExternalStore`) |
| 7  | Review actions split           | `src/browser/hooks/useReviews.ts`, `WorkspaceShell.tsx`      | `WorkspaceShell` subscribed to full review state just to read `addReview`.                                       | New non-subscribing `useReviewActions` |
| 8  | Readiness timing               | `WorkspaceStore.ts`, `chatCommands.ts`                       | Workspace create/fork sent the start message on a `requestAnimationFrame` "is it ready?" guess.                  | `waitForActiveOnChatWorkspace(...)`    |

### Deep dive — metadata selector (slice 6)

The biggest single win. Before, any metadata `Map` replacement fanned out to every consumer:

```mermaid
flowchart LR
    subgraph BEFORE["Before — full Map subscription"]
        direction TB
        MAP["workspaceMetadata: Map<br/>(all workspaces)"]
        MAP --> CC1["ChatPane"]
        MAP --> WMB["WorkspaceMenuBar"]
        MAP --> USM["useSendMessageOptions"]
        MAP --> AGT["AgentContext"]
        MAP --> REV["ReviewPanel"]
    end
```

After, each consumer subscribes to exactly its own entry via a per-workspace `MapStore` + `useSyncExternalStore`:

```mermaid
flowchart LR
    subgraph AFTER["After — per-workspace selector"]
        direction TB
        E1["useWorkspaceMetadataEntry(id)"]
        E1 -.->|"only notifies when<br/>THIS entry changes"| CC2["ChatPane"]
        E1 -.-> WMB2["WorkspaceMenuBar"]
        E1 -.-> USM2["useSendMessageOptions"]
        E1 -.-> AGT2["AgentContext"]
        E1 -.-> REV2["ReviewPanel"]
    end
```

Validated with render-count tests proving an unrelated workspace update no longer re-renders the consumer, while a same-workspace update still does.

---

## 3. What & Where & When — Planned quick wins (Phase 1)

Execution order **A → B → C → D** (smallest correctness fixes first; the medium cache lands last). Mobile is in scope.

### A — Mobile settings persistence ordering · `small`

- **Where:** `mobile/src/hooks/useWorkspaceSettings.ts:222-253`
- **Why:** All four setters call `setXState(v)` then `await writeSetting(...)`. A rejected/out-of-order write leaves UI ahead of disk; reload "undoes" the choice.
- **What:** persist-then-`setState`, rollback on catch.
- **When:** slice 9 (first of Phase 1).

### B — Mobile WorkspaceScreen fire-and-forget writes · `small`

- **Where:** `mobile/src/screens/WorkspaceScreen.tsx:515-520` (`void setModel(...)`, `void setThinkingLevel(...)`) inside a corrective effect (`:495-533`).
- **Why:** fire-and-forget hides rejections; the effect is a derived-state side effect.
- **What:** `await` both with try/catch (full effect removal is out of scope).
- **When:** slice 10.

### C — Mermaid dual HTML sinks · `small`

- **Where:** `src/browser/features/Messages/Mermaid.tsx:367` (modal `innerHTML`) + `:447` (inline `dangerouslySetInnerHTML`).
- **Why:** Two distinct sinks double the XSS audit surface (both already sanitized — low risk).
- **What:** route modal SVG through the same React path; delete the `innerHTML` effect.
- **When:** slice 11.

### D — Workflow row polling consolidation · `medium`

- **Where:** `src/browser/hooks/useWorkflowRunById.ts:84-130` + `src/browser/features/Tools/WorkflowRunToolCall.tsx:674-680`.
- **Why:** Large active workflow trees spawn N independent 2 s pollers (one per active/expanded child row). Overlap is already fixed, but RPC count still scales with tree size.
- **What:** shared `(workspaceId,runId)` cache with one refcounted poller; all rows reading the same run collapse to one RPC per cycle.
- **When:** slice 12 (final Phase 1 item).

```mermaid
sequenceDiagram
    autonumber
    participant Row1
    participant Row2
    participant Row3
    participant Cache as SharedCache (refcounted)
    participant API

    Note over Row1,API: BEFORE — N independent pollers
    par
        Row1->>API: getRun(id)
    and
        Row2->>API: getRun(id)
    and
        Row3->>API: getRun(id)
    end
    Note right of API: 3× RPC per 2s

    Note over Row1,API: AFTER — one refcounted poller
    Row1->>Cache: subscribe(id)
    Row2->>Cache: subscribe(id)
    Row3->>Cache: subscribe(id)
    Cache->>API: getRun(id)
    API-->>Cache: snapshot
    Cache-->>Row1: notify (same snapshot)
    Cache-->>Row2: notify
    Cache-->>Row3: notify
    Note right of API: 1× RPC per 2s
```

---

## 4. When — Timeline & phasing

```mermaid
gantt
    title Optimization pass — phasing (relative)
    dateFormat  YYYY-MM-DD
    axisFormat  %m-%d

    section Phase 0 (DONE)
    Workflow polling overlap       :done, s1, 2026-06-20, 1d
    Command palette persistence    :done, s2, 2026-06-21, 1d
    Sidebar resize churn           :done, s3, 2026-06-22, 1d
    chatCommands storage           :done, s4, 2026-06-23, 1d
    ThresholdSlider drag           :done, s5, 2026-06-24, 1d
    Metadata selector hook         :done, s6, 2026-06-25, 2d
    Review actions split           :done, s7, 2026-06-27, 1d
    Readiness timing               :done, s8, 2026-06-28, 1d

    section Phase 1 (PLANNED)
    Mobile settings ordering (A)   :a,   2026-07-02, 1d
    Mobile WorkspaceScreen (B)     :b,   2026-07-03, 1d
    Mermaid dual sinks (C)         :c,   2026-07-04, 1d
    Workflow row cache (D)         :d,   2026-07-05, 2d

    section Phase 2-3 (DEFERRED)
    ProjectSidebar perf (E/F)      :def1, 2026-07-08, 4d
    Auth token storage (G)         :def2, 2026-07-12, 4d
    StreamingMessageAggregator (H) :def3, 2026-07-16, 6d
    ChatInput decomposition (I)    :def4, 2026-07-22, 6d
```

### Effort & impact (Phase 1)

```mermaid
quadrantChart
    title Phase 1 — effort vs impact
    x-axis "Low effort" --> "High effort"
    y-axis "Low impact" --> "High impact"
    quadrant-1 "Do next"
    quadrant-2 "Schedule"
    quadrant-3 "Drop"
    quadrant-4 "Reconsider"
    "A mobile ordering": [0.2, 0.45]
    "B mobile writes": [0.28, 0.4]
    "C Mermaid sinks": [0.22, 0.5]
    "D workflow cache": [0.6, 0.8]
```

---

## 5. What — Deferred (Phases 2–3)

Explicitly out of scope for this pass (per scope decision).

| ID | Item                          | Where                                         | Complexity | Note                                                |
|----|-------------------------------|-----------------------------------------------|------------|-----------------------------------------------------|
| E  | Sidebar attention fanout      | `ProjectSidebar.tsx:197-269,1660-1680`        | S–M        | Highest-ROI perf item; bulk `subscribeKey` + parent `useState` bump. |
| F  | Sidebar tree-math hot path    | `ProjectSidebar.tsx:2115-2868`                | M          | Extract `ProjectWorkspacesTree`; rely on React Compiler. |
| G  | Auth token in renderer store  | `AuthTokenModal.tsx:34-58`                    | L          | Move to Electron main / secure store.               |
| H  | StreamingMessageAggregator    | `utils/messages/StreamingMessageAggregator.ts`| L          | ~3.7k lines; extract persisted agent-status adapter first. |
| I  | ChatInput decomposition       | `features/ChatInput/index.tsx`                | L          | ~3.5k-line monolith.                                |

---

## 6. How — Validation strategy (per slice)

- Each slice validated in isolation before moving on.
- Renderer/desktop: `bun test <changed files>` + `make typecheck`.
- Mobile (A/B): `make test-mobile` + `make typecheck`.
- No new tautological tests — each test asserts a behavioral branch (render-count delta, RPC collapse, rollback-on-failure), not prose.

---

## Appendix — File change manifest (Phase 0)

```
 src/browser/components/ChatPane/ChatPane.tsx                          (M)
 src/browser/components/WorkspaceMenuBar/WorkspaceMenuBar.tsx          (M)
 src/browser/components/WorkspaceShell/WorkspaceShell.tsx             (M)
 src/browser/components/WorkspaceShell/WorkspaceShell.test.tsx        (M)
 src/browser/contexts/AgentContext.tsx                                  (M)
 src/browser/contexts/AgentContext.test.tsx                            (M)
 src/browser/contexts/CommandRegistryContext.tsx                       (M)
 src/browser/contexts/CommandRegistryContext.test.tsx                  (A)
 src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx          (M)
 src/browser/features/RightSidebar/CodeReview/useReadMore.ts           (M)
 src/browser/features/RightSidebar/CodeReview/useReadMore.test.tsx     (A)
 src/browser/features/RightSidebar/CodeReview/ReviewAssistedStatsReporter.test.tsx (A)
 src/browser/features/RightSidebar/ThresholdSlider.tsx                 (M)
 src/browser/features/RightSidebar/ThresholdSlider.test.tsx            (A)
 src/browser/hooks/useResizableSidebar.ts                              (M)
 src/browser/hooks/useReviews.ts                                       (M)
 src/browser/hooks/useReviews.test.tsx                                 (A)
 src/browser/hooks/useSendMessageOptions.ts                            (M)
 src/browser/hooks/useWorkflowRunById.ts                               (M)
 src/browser/hooks/useWorkflowRunById.test.ts                          (M)
 src/browser/stores/WorkspaceStore.ts                                  (M)
 src/browser/stores/WorkspaceStore.test.ts                             (M)
 src/browser/utils/chatCommands.ts                                     (M)
 src/browser/utils/chatCommands.test.ts                                (M)
```

**Totals:** 19 modified, 5 added · +770 / −234 lines · all `make typecheck` clean.
