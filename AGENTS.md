# AGENTS.md

## Purpose

This file defines repository-wide instructions for Coding Agents working on this project.

More specific instructions may later be introduced by nested `AGENTS.md` files inside individual modules.

## Before Making Changes

Before modifying the repository:

1. Read this file.
2. Read `docs/README.md`.
3. Read documentation relevant to the task.
4. Inspect the current repository state instead of assuming documentation is perfectly up to date.
5. Prefer extending existing conventions over introducing parallel structures.
6. Check `.agent/note/` for relevant project knowledge when applicable.

## Documentation

Documentation is part of the implementation.

When a change affects documented behavior, architecture, workflows, interfaces, engineering decisions, or development processes, update the corresponding documentation in the same change.

Do not keep important project knowledge only in chat history, issue comments, or temporary Agent context.

## Documentation Locations

- `docs/requirements/` — requirements
- `docs/architecture/` — architecture and system design
- `docs/decisions/` — Architecture Decision Records
- `docs/plans/` — active and completed implementation plans
- `docs/development/` — development workflow and engineering practices
- `docs/reference/` — stable technical reference
- `docs/troubleshooting/` — recurring problems and verified solutions
- `.agent/note/` — durable Agent-oriented project knowledge
- `.agent/templates/` — templates used by Coding Agents
- `.agent/skills/documentation/SKILL.md` — documentation maintenance rules

## Documentation Maintenance

Documentation maintenance rules are defined in:

`.agent/skills/documentation/SKILL.md`

When creating, modifying, moving, or deleting project documentation, follow the Documentation Skill.

## Documentation Validation

Before completing changes that affect documentation, run the repository documentation check.

Use the canonical package script:

`docs:check`

The package manager adopted by this repository is pnpm, so the command is:

```bash
pnpm docs:check
```

A change with failing documentation checks is incomplete.

## Source of Truth

Avoid duplicating the same information across multiple documents.

Each important concept should have one canonical location.

Other documents should link to that source instead of copying its contents.

## Bilingual Documentation

Chinese is the primary documentation language.

For documents that require bilingual maintenance:

- `<name>.md` is the canonical Chinese version.
- `<name>.en.md` is the corresponding English version.

The two files are treated as one logical document: when you update one, check whether the other needs to be synchronized, and vice versa. If the two versions ever conflict, the Chinese version wins — fix the English version. Do not produce low-quality machine translation; the English version should read naturally and accurately express the meaning of the Chinese version.

All README documents and formal documents under `.agent/note/` must follow this convention. Do not create empty `.en.md` files for other document types unless bilingual maintenance is actually needed.

## Current Project State

The project is an out-of-tree DSH plugin bundle (`@dsh-electron/dsh-plugin-multi-root-workspace`) that widens the workspace sandbox scope from one root to a primary root plus N additional roots, without modifying any upstream package.

Milestone M1 (bundle composition and empty-root pass-through) is complete and verified: the plugin installs through `dsh plugin`, replaces the two provider rows, and behaves exactly like an uninstalled harness while no additional root is configured. See `docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md` for the evidence and for the T0 findings.

Development environment, toolchain, commands, and the smoke mechanism are documented in `docs/development/plugin-development-workflow.md`. Requirements, design, upstream facts, and decisions live in `docs/requirements/`, `docs/architecture/`, `docs/reference/`, and `docs/decisions/`.

Additional roots, their registration, the kernel-dialect grants, and the client UI are M2/M3 work. Do not invent constraints that are not written down.
