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

Milestone M2 (additional roots and dialect grants) is complete and verified: a registered additional root is enforced both by the in-process fence and by the host kernel dialect (Seatbelt / bwrap / Landlock) through one shared scope, the cross-provider allow matrix is pinned by tests, the workspace topology reaches the model through a runtime-context contribution, and the empty-root behavior stays byte-identical to an uninstalled harness. See `docs/plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md`. Dialect grants are widened by recognizing the profile `super.confine` produced and cloning its grant spelling — never by deep-importing upstream internals (`docs/decisions/ADR-0003-dialect-grant-widening.md`).

Milestone M3 (root registry, `/workspace-folders`, browser panel, journey e2e) is implemented and re-accepted after an external review: roots are persisted in the `multi_root_workspace` storage domain keyed by the canonical primary root, validated on every write and every read, and the registry feeds the M2 scope; the command and the sidebar Workspace Folders panel both manage them, the panel talking to the host over the plugin's own Connection RPC channel; `pnpm smoke:journey` drives a real agent turn across two Git repositories in both the `web` and `headless` compositions. The review's eight findings are fixed, each with a regression test — see the "external review rework" section of `docs/plans/completed/2026-09-12-m3-root-registry-command-and-ui.md`, plus `docs/decisions/ADR-0004-root-registry-persistence-and-validation.md` (rework decisions 9–15) and `docs/decisions/ADR-0005-out-of-tree-client-transport.md`.

Four invariants that must survive future changes:

1. **Re-resolving a path is not re-authorizing it.** A registration carries the canonical directory it was granted for (`recordedPath`); `ctx.multiRootScope` grants it only while `canonicalPath(path)` still equals that value, and reports `redirected` otherwise. Never make a grant follow a replaced directory or symlink.
2. **One write path, serialized.** Registry mutations run their whole read → validate → persist sequence inside the per-primary-root queue (`serialize`); the storage domain only serializes individual writes. Do not read a snapshot outside the queue.
3. **One revalidation entry point.** `registry.refresh()` re-stats, re-resolves, re-judges, republishes the scope, and writes nothing; the command's `list` and the panel's `list` both call it, and listing must remain enough to notice a directory that disappeared. `publish` stays idempotent.
4. **One response shape per panel endpoint.** `src/contract.ts` owns the endpoint → response mapping (`reveal` answers `{ revealed }`, everything else a `RootsView`), and both halves validate the wire shapes at runtime.

Development environment, toolchain, commands, and the smoke mechanism are documented in `docs/development/plugin-development-workflow.md`. Requirements, design, upstream facts, and decisions live in `docs/requirements/`, `docs/architecture/`, `docs/reference/`, and `docs/decisions/`.

`ctx.multiRootScope.setAdditionalRoots()` remains the scope's only write port and is what tests and smoke scripts use; in production the registry calls it. Do not build a second data source. The browser half talks to the host over the Connection RPC channel `/multi-root-workspace` — not over a Typert Remote namespace (ADR-0005). Do not invent constraints that are not written down.
