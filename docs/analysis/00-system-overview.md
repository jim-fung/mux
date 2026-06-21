---
title: System Overview
description: Architectural map of the mux codebase — the single binary that runs as a desktop app, CLI, and headless server.
---

# 00 — System Overview

> **Analyzed at:** `main` @ `4bac642a8` · **App:** `mux` v0.27.0 · **Stack:** Electron 40 + React 18 + Vite 7 + TypeScript + bun

This is the index for the **Codebase Analysis** report suite. It explains how the whole product fits together and links to nine deep-dive reports — one per architectural facet. Each report is self-contained; start here if you want the lay of the land first.

## TL;DR

- **One compiled binary, three runtimes.** `dist/cli/index.js` is simultaneously the Electron main-process entry, the global `mux` CLI binary, and the headless HTTP/WebSocket server. `src/cli/index.ts` branches at startup on `process.versions.electron` + `process.defaultApp`.
- **One backend, two frontends.** A single oRPC router (`src/node/orpc/router.ts`, ~40 namespaces) is served over an in-process Electron `MessagePort`, a WebSocket, and HTTP. The desktop renderer and the React-Native mobile app both bind to the **same typed contract** (`AppRouter`) — only the transport differs.
- **The "runtime" is your code's execution environment, not the AI loop.** `src/node/runtime/` manages _where commands run_ (local / git-worktree / SSH / Docker / devcontainer / multi-project). The AI/LLM loop lives in `src/node/services/` (`agentSession` → `aiService` → `streamManager`).
- **Everything is durable and self-healing.** Chat is an append-only JSONL with partial-message staging; workflows are replayable event journals with leases; malformed history/devtools lines are filtered, never fatal.
- **Tools, MCP, and Skills compose at stream time.** Built-in tools + MCP server tools + skill metadata are merged per-workspace into the model's toolset right before each `streamText()` call.

---

## 1. Layered architecture

```mermaid
flowchart TD
    subgraph CLI["CLI surface (src/cli/*)"]
        C1["index.ts — one entry, branches on env"]
        C2["run.ts · workflow.ts · trust.ts (headless only)"]
        C3["server.ts · acp.ts · api.ts (both)"]
        C4["debug/index.ts (bun run debug)"]
    end
    subgraph DESKTOP["Desktop (src/desktop/*)"]
        D1["main.ts — BrowserWindow, lifecycle, deep-links"]
        D2["preload.ts — contextBridge + MessagePort relay"]
        D3["updater.ts · terminalWindowManager.ts"]
    end
    subgraph NODE["Node backend (src/node/**)"]
        N1["orpc/router.ts — single typed router (~40 namespaces)"]
        N2["services/* — AI loop, tools, MCP, workflows, history, config"]
        N3["runtime/* — local/worktree/ssh/docker/devcontainer exec"]
        N4["config.ts — ~/.mux/config.json"]
    end
    subgraph COMMON["Shared core (src/common/**)"]
        CM1["orpc/schemas + types (the contract)"]
        CM2["constants/ (providers, knownModels, paths)"]
        CM3["utils/ (tokens, ai, tools, telemetry)"]
    end
    subgraph BROWSER["Desktop renderer (src/browser/**)"]
        B1["App.tsx — shell + 11 providers"]
        B2["stores/* — external stores (useSyncExternalStore)"]
        B3["components/* + features/* (React Compiler)"]
    end
    subgraph MOBILE["Mobile app (mobile/**)"]
        M1["app/* — expo-router screens"]
        M2["src/orpc/client.ts — RPCLink over SSE"]
    end

    CLI --> NODE
    DESKTOP --> NODE
    NODE --> COMMON
    BROWSER --> COMMON
    MOBILE --> COMMON
    DESKTOP -. "MessagePort oRPC" .-> BROWSER
    NODE -. "HTTP/WS oRPC" .-> MOBILE
```

## 2. One binary, three runtimes

`package.json` declares **both** `"main": "dist/cli/index.js"` and `"bin": { "mux": "dist/cli/index.js" }`. The same file serves every launch mode; detection happens in `src/cli/argv.ts`:

| Launch                             | `isElectron` | `process.defaultApp` | Behavior                       |
| ---------------------------------- | ------------ | -------------------- | ------------------------------ |
| `bun mux` / `npx mux`              | false        | —                    | CLI help + subcommands         |
| `electron .` (dev)                 | true         | true                 | Loads `src/desktop/main.ts`    |
| Packaged `.app`/`.AppImage`/`.exe` | true         | —                    | Launches desktop automatically |

Subcommands are lazily `require()`-d so heavy modules (AI SDK, Electron) only load on the path actually needed. `run`/`workflow`/`trust` are bun/node-only; `desktop` is Electron-only; `server`/`acp`/`api` work in both.

```mermaid
flowchart LR
    BIN["dist/cli/index.js<br/>(package.json main + bin)"] --> DET{"argv.ts<br/>detectCliEnvironment()"}
    DET -->|"bun/node"| CLI["CLI subcommands<br/>run · workflow · server · acp · api · debug"]
    DET -->|"electron"| DT["src/desktop/main.ts"]
    CLI -.->|"server / acp"| ORPC["oRPC router<br/>(shared backend)"]
    DT --> ORPC
    ORPC -->|"MessagePort"| RENDER["Desktop renderer"]
    ORPC -->|"HTTP/WS + SSE"| MOB["Mobile app"]
```

## 3. End-to-end request lifecycle

The canonical path — a user sends a message in the desktop app and watches it stream back as text + tool cards:

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as Renderer (ChatPane)
    participant WS as WorkspaceStore
    participant IPC as oRPC (MessagePort)
    participant AS as AgentSession
    participant AI as AIService
    participant SM as StreamManager
    participant SDK as AI SDK streamText()
    participant P as Provider (e.g. Anthropic)

    U->>R: type message, press send
    R->>IPC: workspace.sendMessage({message})
    IPC->>AS: sendMessage() [phase: PREPARING]
    AS->>AS: build history → request (resolve agent/system prompt, tools)
    AS->>AI: streamMessage(opts)
    AI->>AI: resolveAndCreateModel() → LanguageModel
    AI->>SM: startStream() [acquire per-workspace mutex]
    SM->>SDK: streamText({model, messages, tools, stopWhen})
    SDK->>P: POST /v1/messages (SSE)
    P-->>SDK: text-delta / tool-call / reasoning deltas
    loop per fullStream part
        SDK-->>SM: part (text/tool/reasoning/finish)
        SM->>SM: appendPartAndEmit() + throttled writePartial()
        SM-->>AI: emit stream-delta / tool-call-start/end
        AI-->>IPC: relay event
        IPC-->>WS: live stream subscriber
        WS-->>R: re-render tool cards / text
    end
    SM->>SM: commitPartial() → appendToHistory (chat.jsonl)
    SM-->>AS: stream-end [phase: IDLE]
```

> Details (turn construction, compaction, cost, retry, sub-agents) are in [03 — AI & Agent Runtime](analysis/03-ai-agent-runtime).

## 4. The `~/.mux` data directory

Almost all persistent state lives under one home directory (`getMuxHome()` → `$MUX_ROOT` or `~/.mux`, with a `-dev` suffix in development):

```mermaid
flowchart TD
    MUX["~/.mux/"]
    MUX --> CFG["config.json<br/>(projects, workspaces, prefs)"]
    MUX --> PROV["providers.jsonc<br/>(API keys, base URLs, models)"]
    MUX --> SEC["secrets.json<br/>(project secrets)"]
    MUX --> MCP["mcp.jsonc<br/>(global MCP servers)"]
    MUX --> SRC["src/"]
    SRC --> PROJ["&lt;projectName&gt;/&lt;workspaceName&gt;<br/>(git worktrees)"]
    SRC --> MULTI["_workspaces/&lt;name&gt;/<br/>(multi-project containers)"]
    MUX --> SESS["sessions/"]
    SESS --> WS["&lt;workspaceId&gt;/"]
    WS --> CHAT["chat.jsonl<br/>(active epoch)"]
    WS --> ARC["chat-archive.jsonl<br/>(sealed pre-boundary)"]
    WS --> PART["partial.json<br/>(in-flight message)"]
    WS --> DEV["devtools.jsonl<br/>(API debug logs)"]
    MUX --> SKILLS["skills/ + agents/skills/<br/>(global skills)"]
    MUX --> WF["workflows/ + workflows/.scratch/"]
    MUX --> LOGS["logs/ · telemetry_id · debug_obj/"]
    MUX --> DUCK["analytics.duckdb<br/>(local spend/tokens)"]
```

Persistence semantics (atomic writes, leases, self-healing) are covered in [05 — Workspace & Persistence](analysis/05-workspace-persistence).

## 5. Report index

| #   | Report                                                               | What it covers                                                                          |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 01  | [Architecture & Build](analysis/01-architecture-build)               | Electron process model, security posture, the 5 build outputs, distribution/auto-update |
| 02  | [IPC & Configuration](analysis/02-ipc-config)                        | The oRPC router + transports, the schema-first contract, the `Config` system            |
| 03  | [AI & Agent Runtime](analysis/03-ai-agent-runtime)                   | Providers, model registry, the turn/stream loop, agents, ACP, tokens/cost/compaction    |
| 04  | [Tools, MCP & Skills](analysis/04-tools-mcp-skills)                  | Tool taxonomy, execution path, MCP merge, skills lifecycle, QuickJS sandbox             |
| 05  | [Workspace & Persistence](analysis/05-workspace-persistence)         | Worktrees, multi-project, SSH, history, partial messages, compaction                    |
| 06  | [Workflow Engine](analysis/06-workflow-engine)                       | The durable JS conductor, steps/patches, replay, crash recovery                         |
| 07  | [React Frontend](analysis/07-react-frontend)                         | App shell, external-store state, design system, terminal                                |
| 08  | [Mobile Application](analysis/08-mobile)                             | Expo/RN client and the shared-contract seam with desktop                                |
| 09  | [Testing, CI, Security & Telemetry](analysis/09-testing-ci-security) | Test matrix, CI pipeline, security controls, telemetry/observability                    |

## 6. Glossary

| Term           | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **oRPC**       | The typed-RPC framework (oRPC.dev) used everywhere instead of raw `ipcMain`/`ipcRenderer`.              |
| **Workspace**  | One running agent context = a git worktree (or SSH clone) + its session directory.                      |
| **Runtime**    | _Where shell commands execute_ (local / worktree / ssh / docker / devcontainer). Not the AI loop.       |
| **ACP**        | Agent Client Protocol — the stdio NDJSON protocol Mux speaks so editors (Neovim, VS Code) can drive it. |
| **Partial**    | The in-flight assistant message staged in `partial.json`, committed to `chat.jsonl` on stream end.      |
| **Compaction** | Summarizing history into a durable boundary when the context window fills.                              |
| **Skill**      | A discoverable `SKILL.md` instruction pack the agent loads on demand.                                   |
| **Workflow**   | A durable JavaScript conductor that orchestrates sub-agent tasks + host actions, replayable on crash.   |

---

_Reports in this suite describe the system as-of the analyzed commit and may drift as the codebase evolves._
