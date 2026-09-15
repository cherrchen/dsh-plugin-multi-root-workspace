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

The `v0.1.1` hardening batch (**H1–H4**) landed on 2026-09-15 on `fix/v0.1.1-hardening` and is **not yet released** (`package.json` is still `0.1.0`; the only tag is `v0.1.0`). Numbering, so that historical documents agree: **M1–M3** are the MVP milestones released as `v0.1.0`, **H1–H4** are this batch, and **H1 is the same work as M4** under its second name; H4 has a Phase 1 (implemented) and a Phase 2 (deferred to the second phase). Progress, numbering and release state have exactly one home: the progress ledger in `docs/plans/active/2026-09-12-multi-root-workspace.md`.

The batch's four items:

- **H1 (= M4) — one Registry Authority Process per store.** A store-wide kernel lease beside the JSON document; a contended process is fail-closed and takes over via `refresh()`. See `docs/decisions/ADR-0007-registry-authority-lease.md`.
- **H2 — panel authority is host-derived.** The client `primaryRoot` field is gone and every endpoint requires a live `sessionId`. See `docs/decisions/ADR-0008-panel-session-derived-authority.md`.
- **H3 — DSH compatibility is a code contract rather than a documented agreement**: `src/compat/dsh-version.ts` holds an exact-version allowlist (`SUPPORTED_DSH_RELEASES`), `peerDependencies` names those same versions, `scripts/check-dsh-compat.mjs` (`pnpm compat:check`, first step of CI) fails when any of allowlist / peers / dev pin / installed tree drift apart, and the `multi-root-compat` row classifies the installation at boot. Both `0.1.5-rc.2` and `0.1.6-alpha.1` are supported and both pass the full matrix; the dev pin stays at `0.1.5-rc.2`.
- **H4 Phase 1 — additional roots' own `AGENTS.md` / `CLAUDE.md` now reach the model** through the `multi-root-instructions` row, because upstream's discovery walks upward from the session cwd and can never reach them; Phase 2 (nested instructions driven by touched paths) is deliberately not implemented. See `docs/plans/completed/2026-09-15-dsh-compat-contract.md` and `docs/decisions/ADR-0010-additional-root-instruction-scope.md`.

Nine invariants that must survive future changes:

1. **Re-resolving a path is not re-authorizing it.** A registration carries the canonical directory it was granted for (`recordedPath`); `ctx.multiRootScope` grants it only while `canonicalPath(path)` still equals that value, and reports `redirected` otherwise. Never make a grant follow a replaced directory or symlink.
2. **One write path, serialized.** Registry mutations run their whole read → validate → persist sequence inside the per-primary-root queue (`serialize`); the storage domain only serializes individual writes. Do not read a snapshot outside the queue.
3. **One revalidation entry point.** `registry.refresh()` re-stats, re-resolves, re-judges, republishes the scope, and writes nothing; the command's `list` and the panel's `list` both call it, and listing must remain enough to notice a directory that disappeared. `publish` stays idempotent. `refresh()` also retries the store-wide authority lease so a waiting process can take over after the previous holder exits.
4. **One response shape per panel endpoint.** `src/contract.ts` owns the endpoint → response mapping (`reveal` answers `{ revealed }`, everything else a `RootsView`), and both halves validate the wire shapes at runtime.
5. **The client-graph anchor stays.** The web client-module scan reads this package's `dsh.client` only from a loader row mounted at the bare package name — subpath rows are never client rows. `cordis.patch.yml` must keep the `multi-root-client` row (`name` = the bare package name, backed by the barrel's no-op `apply`), or `lib/client.js` never reaches the browser and the `sidebar.footer.action` registration silently disappears. See `docs/troubleshooting/client-bundle-not-in-boot-graph.md`.
6. **One Registry Authority Process per store.** The JSON backend is memory-authoritative after open. Only the process holding the store-wide kernel lease (`leasePath`, default `$DSH_HOME/storages/multi_root_workspace.lock`) may open the domain and grant additional roots. A contended process publishes an empty scope and rejects mutations (`registry-contended`). Do not add a TTL/PID lock, and do not open the domain before acquiring the lease. See `docs/decisions/ADR-0007-registry-authority-lease.md`.
7. **The compatibility gate is a precondition, not a diagnostic.** `multi-root-fs`, `multi-root-sandbox`, `multi-root-registry` and `multi-root-instructions` all inject `multiRootCompat`, and cordis will not start a row whose injected service is missing — so an unsupported or mixed installation makes those four rows simply not exist. Keep that injection on any new row that widens authority. Version-dependent code belongs only in `src/compat/`, and it must probe *structure* (is the return value thenable? which renderer name is exported?) rather than compare version strings. `DSH_MULTI_ROOT_COMPAT=warn` has exactly one legitimate caller, the upgrade lane. Promoting a release is a human act: a green upgrade run is evidence, never authorization. See `docs/decisions/ADR-0009-dsh-compat-contract.md`.
8. **Instructions are user context, never system authority, and revocation is explicit.** `multi-root-instructions` injects each additional root's **top-level** instruction file from `agent/pre-step` as a `{ kind: 'plugin', form: 'instructions' }` user message — not through `systemPrompt`, and not from a lifecycle event. Discovery is pinned to the root itself (`cwd` and `projectRoot` both the root, then a canonical containment filter), which is what keeps `$DSH_HOME`, the primary root, and any ancestor from being injected a second time. The byte budget is shared across all additional roots, not per root. When a root is removed, disappears, or is `redirected`, emit an explicit revocation: the earlier instructions are still in the conversation, so going silent does not retract them. With zero additional roots this row must contribute nothing at all. Nested instructions (subdirectory files discovered from touched paths) are **not implemented** — that is Phase 2 of this row, deliberately deferred to the second phase until the `SessionMessageProjection` semantics added in 0.1.6 are evaluated; never fake it by reusing the primary workspace's reconcile path. See `docs/decisions/ADR-0010-additional-root-instruction-scope.md`.
9. **Panel authority is host-derived from the session.** Every panel request requires `sessionId`; `resolvePanelPrimaryRoot` looks up `ctx.get('sessions')?.get(sessionId)` and returns `canonicalPath(session.header.cwd)`. There is no client `primaryRoot` field and no `sandboxPolicy` fallback. A missing or unknown session is rejected; a client with no current session shows "No active session" and does not call the host. The `/workspace-folders` command still uses `invocation.agent.session` (trusted host context). See `docs/decisions/ADR-0008-panel-session-derived-authority.md`.

Before touching the compatibility contract, the adapters, or anything that has to work on more than one upstream release, read `.agent/note/dsh-compat-contract.md` — it records the measured 0.1.5 → 0.1.6 differences and the quiet traps (a `confine` that is sync on one release and async on the next, two LLM wire protocols in the journey smoke, a local `git checkout` revert step that eats uncommitted manifest edits).

Development environment, toolchain, commands, and the smoke mechanism are documented in `docs/development/plugin-development-workflow.md`. Requirements, design, upstream facts, and decisions live in `docs/requirements/`, `docs/architecture/`, `docs/reference/`, and `docs/decisions/`.

`ctx.multiRootScope.setAdditionalRoots()` remains the scope's only write port and is what tests and smoke scripts use; in production the registry calls it. Do not build a second data source. The browser half talks to the host over the Connection RPC channel `/multi-root-workspace` — not over a Typert Remote namespace (ADR-0005). The client UI's styling is the host's: `src/client/styles.ts` is the single stylesheet, classes are `mrfw-`-prefixed, and every color is a host `var(--dsw-*)` token — never a literal color (ADR-0006). Do not invent constraints that are not written down.
