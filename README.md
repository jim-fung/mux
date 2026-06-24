<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/white-mux.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/img/black-mux.svg" />
  <img src="docs/img/black-mux.svg" alt="mux logo" width="18%" />
</picture>

# Mux Fork - Coding Agent Multiplexer

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

</div>

This repository is a fork of [Coder's official Mux](https://github.com/coder/mux), a desktop and browser app for parallel agentic development. It keeps the core Mux workflow and UX, while extending it with additional provider and model support plus deeper Headroom integration.

<p><img src="./docs/img/mux-demo.gif" alt="mux product demo" width="100%" /></p>

## What Sets This Fork Apart

Compared with the official Mux repo, this fork adds:

- **Chinese direct providers built in**
  - DeepSeek
  - Z.AI
  - Moonshot AI
  - MiniMax
  - Xiaomi
  - Alibaba / DashScope
- **Chinese built-in models**
  - DeepSeek V4 Pro / Flash
  - GLM
  - Kimi
  - MiniMax
  - Mimo
  - Qwen
- **Built-in local LLM providers** (OpenAI-compatible, no API key required)
  - LM Studio (`http://localhost:1234/v1`)
  - oMLX (`http://localhost:8000/v1`)
- **Headroom integration with an extensive configuration UI**
  - Provisioning and runtime controls
  - Middleware vs proxy modes
  - Per-provider routing controls
  - Advanced tuning and presets
  - Workspace-level overrides
- **SharedContext for subagent report compression**
  - Auto-compresses background subagent reports at delivery time via the Headroom proxy
  - In-process store with TTL and LRU eviction
  - Reduces parent context footprint across long delegation chains
  - Fail-open: full report delivered uncompressed if the proxy is unavailable
- **Dedicated Headroom Stats section in Settings**
  - Live compression totals
  - Tokens saved
  - Reduction percentage
  - Persistent usage totals

## Base Mux Features

Mux is a desktop & browser application for parallel agentic development. It enables developers to plan and execute tasks with multiple AI agents on local or remote compute.

- **Isolated workspaces** with central view on git divergence ([docs](https://mux.coder.com/runtime))
  - **[Local](https://mux.coder.com/runtime/local)**: run directly in your project directory
  - **[Worktree](https://mux.coder.com/runtime/worktree)**: git worktrees on your local machine
  - **[SSH](https://mux.coder.com/runtime/ssh)**: remote execution on a server over SSH
- **Multi-model** (`sonnet-4-*`, `grok-*`, `gpt-5-*`, `opus-4-*`)
  - Ollama supported for local LLMs ([docs](https://mux.coder.com/config/models#ollama-local))
  - OpenRouter supported for long-tail of LLMs ([docs](https://mux.coder.com/config/models#openrouter-cloud))
- **VS Code Extension**: Jump into Mux workspaces directly from VS Code ([docs](https://mux.coder.com/integrations/vscode-extension))
- Supporting UI and keybinds for efficiently managing a suite of agents
- Rich markdown outputs (mermaid diagrams, LaTeX, etc.)

Mux has a custom agent loop but much of the core UX is inspired by Claude Code. You'll find familiar features like Plan/Exec mode, vim inputs, `/compact` and new ones
like [opportunistic compaction](https://mux.coder.com/workspaces/compaction) and [mode prompts](https://mux.coder.com/agents/instruction-files#mode-prompts).

## Why This Fork

This fork is aimed at users who want the Mux experience but need:

- Better support for Chinese AI providers without custom provider setup
- Built-in access to popular Chinese model families from the model picker
- Stronger Headroom-based context compression controls
- Lower token cost on multi-agent delegation via automatic report compression
- Better visibility into Headroom behavior through a dedicated stats section

## Install

Use this fork if you want the added provider, model, and Headroom capabilities described above.

If you are looking for upstream Mux releases and documentation, see:

- Official repo: [coder/mux](https://github.com/coder/mux)
- Official docs: [mux.coder.com](https://mux.coder.com)

## More reading

See [the official Mux documentation](https://mux.coder.com) for the upstream product and core concepts.

## Development

See [AGENTS.md](./AGENTS.md) for development setup and guidelines.

## License

Copyright (C) 2026 Coder Technologies, Inc.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 of the License.

See [LICENSE](./LICENSE) for details.
