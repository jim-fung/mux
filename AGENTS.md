---
title: Mux Agent Guide
description: Focused instructions for AI-assisted changes in this repository.
---

## Priorities

- Make the smallest correct change. Preserve existing user or concurrent-agent edits.
- Mux is an Electron, React, TypeScript app for parallel agent workflows. Keep interactions responsive, predictable, and resilient to bad persisted state or failed startup work.
- This fork adds Chinese/local provider support. Treat `src/common/constants/knownModels.ts` as the source of truth for model IDs.
- Minor breaking changes are acceptable when tightly scoped. Do not add migrations or compatibility layers without a concrete persisted-data or external-consumer need.

## Repository Map

- `src/browser/`: renderer UI; `src/desktop/`: Electron process integration; `src/node/`: services, agent runtime, and server; `src/common/`: shared types, schemas, and utilities; `src/cli/`: CLI.
- `mobile/` is a separate Bun/React Native project. `vscode/` has its own Makefile.
- Persistent state: `~/.mux/config.json`, `~/.mux/src/<project>/<branch>`, and `~/.mux/sessions/<workspace>/chat.jsonl`.
- Generated built-in agent/skill sources are maintained by Make targets. Edit their source files, never generated outputs, unless the task explicitly requires generated artifacts.

## Working Practices

- Inspect the relevant code and existing tests before editing. Use `git mv` for moves.
- Use Bun only. The Makefile is the command source of truth; add commands there rather than `package.json`.
- Primary commands: `make dev`, `make start`, `make build`, `make static-check`, `make static-check-full`, `make test`, `make test-integration`, `make test-mobile`, `make test-e2e`, `make storybook`, and `make test-storybook`.
- Run the narrowest relevant test, then `make static-check` for substantive changes. `make static-check-full` additionally crawls documentation links and validates the bench agent.
- Do not submit Terminal-Bench leaderboard changes. Provide commands for the user to run instead.
- Prefer `gh` for GitHub work. Before creating or updating a commit, public issue, or PR, read the local `pull-requests` skill for attribution and workflow requirements.

## Architecture And Reliability

- Batch IPC reads: never implement O(n) renderer-to-main calls when one bulk call can provide the data.
- IPC returns shared backend types, not ad-hoc copies. The renderer may add UI context, but must not duplicate boundary schemas or synthesize workspace IDs; consume IDs returned by backend operations.
- Persist before publishing in-memory state when observers can see both. Avoid unawaited async work and timer-based coordination when an explicit lifecycle signal exists.
- Startup initialization must fail safely. Catch errors, bound slow work, and degrade without preventing the app from opening.
- Sanitize malformed persisted history at load/request boundaries. A corrupt line or interrupted stream must not permanently brick a workspace or be sent to a provider.
- Use the backend `log` helper; use `log.debug` for noisy diagnostics.

## TypeScript And Tool Schemas

- Do not use `as any`. Prefer authored interfaces, discriminated unions, type guards, utility types, and exhaustive `Record<Enum, Value>` mappings.
- Centralize cross-layer constants in `src/constants/`; do not duplicate constant values in comments.
- Use static imports. Break circular dependencies with extracted shared modules or dependency injection, never dynamic imports.
- For optional model-tool input fields, use Zod `.nullish()` and handle absence with `!= null`. This applies to inputs only, not output schemas.
- Dispose processes, handles, and similar resources with `using` or an equivalent guaranteed cleanup path.

## React And UI

- React Compiler is enabled. Do not add `React.memo`, `useMemo`, or `useCallback` merely for memoization.
- Before adding `useEffect`, read the local `react-effects` skill. Derive render state during render, reset with keys, and perform user-triggered work in handlers; reserve effects for external synchronization.
- Colocate live subscriptions with their display leaf. Prefer self-contained components over long prop and callback chains.
- Never access `localStorage` directly. Use `usePersistedState`, `readPersistedState`, or `updatePersistedState`; parents own persistence and children announce intent.
- Use existing design primitives and CSS variables from `src/browser/styles/globals.css`. Do not hardcode colors, use native `title` tooltips, or use emoji as UI icons. Prefer Lucide/shared SVG icons and `Tooltip`/`TooltipIfPresent`.
- Use `counter-nums` for changing numeric UI; use `counter-nums-mono` only where monospace is intentional.
- Verify renderer changes at desktop and approximately 375px widths. For breakpoint-dependent stories, pin a Chromatic viewport and ensure narrow assertions control their rendered width.
- User-facing desktop operations need a keyboard shortcut; do not display that shortcut on mobile. Use `stopKeyboardPropagation` when native global keyboard listeners must not receive an event.
- Do not add animations, auto-dismissal, or other UX flourishes unless requested.

## Security And Comments

- Treat repository-controlled strings such as paths, diffs, branch names, and commit messages as untrusted. Do not pass them through `dangerouslySetInnerHTML`, DOM HTML setters, or `insertAdjacentHTML`.
- Prefer escaped React element trees for highlighting. If raw HTML or SVG is unavoidable, sanitize it and document the trust boundary with a `SECURITY AUDIT` comment at the sink.
- Add comments only for non-obvious rationale, invariants, or surprising implementation details. Keep comments accurate when behavior changes.

## Tests And Documentation

- Tests must exercise behavior, branches, or invariants. Do not add tautological assertions for copied text, prompts, or renamed constants.
- Test `HistoryService` through `createTestHistoryService()` and real disk behavior, not a mocked service. Seed with `appendToHistory()` and assert by reading history back.
- UI tests run in happy-dom: Radix portals do not render reliably there. Prefer conditional inline rendering for dropdown/popover content requiring UI tests; reserve Electron E2E for behavior that requires it.
- Documentation belongs in `docs/`; read `docs/README.md`, add navigable pages to `docs/docs.json`, and follow `docs/STYLE.md`. Do not add root-level Markdown or ad-hoc planning documents. The `rfc/` directory is the exception for human-authored RFCs.

## PRs

- Do not create a PR unless explicitly asked. Reuse an existing PR and push completed change sets when one is already open.
- For PR work, follow the local `pull-requests` skill exactly. Audit every reviewer and bot, address feedback before resolving threads, re-request review as required, and use `./scripts/wait_pr_ready.sh <pr_number>` only after useful local validation is exhausted.
- Do not report an existing PR as ready until all required checks pass, Codex has approved, and all Codex review threads are resolved. Pause only for a clearly mistaken review that needs human direction.
