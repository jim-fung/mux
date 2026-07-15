---
title: Documentation Agent Guide
description: Documentation-specific additions to the repository-wide agent guide.
---

The root `AGENTS.md` applies to documentation changes. Additionally:

- Read `docs/README.md` and `docs/STYLE.md` before changing user documentation.
- Add each new user-facing page to `docs/docs.json` navigation and include title and description frontmatter.
- Use standard Markdown and Mermaid where appropriate. Keep links valid; validate documentation changes with `make check-docs-links` when practical.
- Do not place developer notes, plans, or scratch Markdown in `docs/`. Keep implementation rationale in code comments instead.
