# Plans

中文：[README.md](./README.md)

## What Belongs Here

Implementation plans for large development tasks, such as:

- Features;
- Refactors;
- Migrations;
- Architectural changes.

## Directory Layout

```text
active/     plans that are in progress or not yet started
completed/  completed plans
```

When a task is finished, move its plan from `active/` to `completed/`:

```text
active/
→
completed/
```

Plans with long-term reference value should not be deleted.

## What Does Not Belong Here

- Scratch TODOs for small tasks;
- Abandoned drafts with no reference value (just delete those);
- Formal design documents (goes to `../architecture/`, or use `../../.agent/templates/design.md`).

## Current State

active:

- [2026-11-09-worktree-aware-root-suggestions.md](./active/2026-11-09-worktree-aware-root-suggestions.md) (Chinese) — P1–P7 cover worktree root suggestions, the plugin toggle, and manual cleanup (B). P8–P10 add explicit access to shared Git metadata for linked worktrees (A). See [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md) for the decision and the roadmap for progress; shipping in `v0.1.17`.

- [2026-11-08-workspace-menu-folders-dialog.md](./active/2026-11-08-workspace-menu-folders-dialog.md) (Chinese) — A "Manage workspace folders…" entry in the workspace `...` menu: a controller reusing the footer dialog, a `workspace` context-menu contribution (order 150), and switching/reusing the target workspace's blank session before opening with that fixed session; `RootSwitcher` and upstream `WorkspaceBrowser` stay untouched (decision in [ADR-0038](../decisions/ADR-0038-workspace-menu-folders-dialog.md)).

- [2026-10-31-f4-background-recovery.md](./active/2026-10-31-f4-background-recovery.md) (Chinese) — F4 background-recovery and diagnostics plan (**rev.4 review passed, adopted via ADR-0026; implemented and accepted on three-platform CI, real-TUI soak deferred, shipping in `v0.1.13`**): a recovery scheduler reusing `ensureAuthority`, a projection-sync completion contract, atomic failed-round publication (including scope-subscriber batching), local handshake cancellation, and a diagnostics surface; the batch is registered in the progress ledger.

- [2026-10-30-shared-registry-authority.md](./active/2026-10-30-shared-registry-authority.md) (Chinese) — Full original Long-term scope for Issue #24, comparison of the released baseline and the initial shared-service commit, six P1 audit items, and future evolution with exit criteria; the initial version is released with `v0.1.12`, and the remaining Ubuntu report-environment soak retest plus progress stay in the roadmap ledger.

- [2026-10-16-branch-security-review-and-hardlink-isolation.md](./active/2026-10-16-branch-security-review-and-hardlink-isolation.md) (Chinese) — Branch review evidence and proposed fixes for deny boundaries, ancestor renames on Windows, and pnpm hard-link isolation; Phases A (R2/R3 negative authorization), B (R1 ancestor pinning), C1 (all-root hardlink preflight) and C2 (the `/workspace-folders isolate-profiles` command, migration and smokes) are implemented and accepted, released with `v0.1.7`.

- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace development path and **progress ledger**: the MVP `v0.1.0` milestones M1/M2/M3 are implemented and released; the `v0.1.1` hardening batch H1–H4 is implemented and released with `v0.1.1`; the `v0.1.2` support-matrix expansion is implemented and released with `v0.1.2`; the `v0.1.3` support-matrix expansion (`0.1.7-alpha.2` / `0.1.7-rc.1`) is implemented and released with `v0.1.3`; the `v0.1.4` support-matrix expansion (`0.1.7-rc.2`) is implemented and released with `v0.1.4`; `v0.1.5` (DSH `0.2.0-rc.1` / `.2`) is released; `v0.1.6` (DSH `0.2.1-alpha.1` / `.2`, B1–B3, and dynamic cwd) is released; `v0.1.7` (the second-phase B batches, Files-tab additional-root browsing, and DSH `0.2.1-alpha.3`–`0.2.1-rc.2`) is released; `v0.1.8` (the DSH 0.2.0 `permissionPresets/catalog` fix) is released; `v0.1.9` (the optional in-package Auto Review entry) is released; `v0.1.10` (additional-root Skills, the Workspace Folders panel alignment, and DSH `0.2.1-rc.3`) is released; `v0.1.11` (DSH `0.2.1-rc.4` and `0.2.2-alpha.2` compatibility plus the Issue #24 Registry/Skills refresh-loop hot-fix) is released; `v0.1.12` (the shared multi-Host registry authority, per-operation admission, and DSH `0.2.1-rc.5`) is released; `v0.1.13` ships F4 background recovery and the Files-tab root-selection fix; `v0.1.14` ships the Issue #30 dependency-singleton fix with host-anchored koffi, DSH `0.2.2-alpha.3`/`0.2.2-rc.1` compatibility, and the plugin-detail settings-card Auto Review toggle plus rich detail page; `v0.1.15` ships the `/add-dirs` alias, root-authorization security fixes, and default-off experimental OPS safeguards with activation risk confirmation; `v0.1.16` ships the unadmitted confined-spawn fix, the panel's persisted-but-not-live session classification, and the preview Folder navigator's additional-root retarget; `v0.1.17` ships experimental worktree root suggestions with linked-worktree main-checkout authorization, the New Session hero and workspace `...` menu Workspace Folders entries, and the approved one-shot Full-access escalation override; `v0.1.18` ships exact support for DSH `0.2.2-rc.2`, with Files-tab search brought under the shared admission and root boundary.


completed:

- [2026-11-08-workspace-folders-hero-entry.md](./completed/2026-11-08-workspace-folders-hero-entry.md) (Chinese) — An incremental Workspace Folders entry on the New Session hero row: a `conversation.hero.options` registration, the adjacent selectors' geometry without a chevron, and a `≤560px` viewport icon-only degrade; the sidebar entry remains. Completed 2026-11-08 and passed the full gate, shipping in `v0.1.17`; decision: [ADR-0037](../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md).

- [2026-11-05-root-authorization-security-fixes.md](./completed/2026-11-05-root-authorization-security-fixes.md) (Chinese) — Completed bounded root-authorization fixes: BYP-02, MRW-01, protected-directory registration, and required shared mode. Excluded work remains out of scope; evidence and release status live in the [progress ledger](./active/2026-09-12-multi-root-workspace.md#进度总账).

- [2026-11-01-ops-compatibility-adaptation.md](./completed/2026-11-01-ops-compatibility-adaptation.md) (Chinese) — Bounded P0–P6 implementation and final acceptance of experimental OPS safeguards; P5 compatibility recovery is deferred indefinitely, with the feature off by default. Status and evidence are in the progress ledger.

- [2026-10-23-multi-root-skills.md](./completed/2026-10-23-multi-root-skills.md) (Chinese) — S1–S7 dependencies, tasks and exit criteria for ADR-0023: Registry, Session discovery and native cwd bypass prevention, on-demand invocation, caching/RPC, Web/Settings, and full release validation; implemented and released with `v0.1.10`, evidence in the roadmap ledger.
- [2026-10-20-auto-review-in-package-review.md](./completed/2026-10-20-auto-review-in-package-review.md) (Chinese) — Requirements review for moving Auto Review into the main package: feasibility, minimal loader probes, takeover and restoration boundaries, proposed contract, and acceptance criteria; implemented and released with `v0.1.9`.
- [2026-10-18-auto-review-context-adaptation.md](./completed/2026-10-18-auto-review-context-adaptation.md) (Chinese) — Phase 0–2 implementation plan: the explicit companion fork, shared permission preview, current constraints, joint verification, and migration to a formal upstream API; status and evidence belong to the roadmap ledger.
- [2026-10-13-b9-root-access-and-sandbox-modes.md](./completed/2026-10-13-b9-root-access-and-sandbox-modes.md) (Chinese) — B9 implementation plan: inherited, read-only, and read-write additional-root policies enforced across SandboxMode values, covering migration, process entry points, native backend feasibility, and acceptance checks. Progress and release state belong to the progress ledger.
- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 development plan: bundle skeleton, two-row provider replacement, empty-root pass-through (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 development plan: dialect grant widening, the parity matrix, the topology snapshot, and the multi-root smoke battery (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 development plan: the root registry and its persistence, the `/workspace-folders` command, the browser Folders panel, and the cross-repository journey e2e (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — `v0.1.1` batch H1 (roadmap M4): the cross-process Registry Authority Lease (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-panel-session-derived-authority.md](./completed/2026-09-15-panel-session-derived-authority.md) — `v0.1.1` batch H2: panel primary root derived from the host session, the client `primaryRoot` field removed (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-dsh-compat-contract.md](./completed/2026-09-15-dsh-compat-contract.md) — `v0.1.1` batch H3 + H4 Phase 1: DSH compatibility becomes a code contract enforced at startup, bringing `0.1.6-alpha.1` and top-level additional-root instruction injection in with it (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-v0.1.1-review-rework.md](./completed/2026-09-15-v0.1.1-review-rework.md) — pre-release rework for PR #1 on the `v0.1.1` batch (2 P1 + 3 P2 findings): authority teardown order (drain → close → release), intermediate-directory instructions becoming reachable, `warn` relaxing `unsupported` only, both optional peers loaded on demand, and absence separated from evaluation failure (implemented 2026-09-15, released with `v0.1.1`).
- [2026-10-12-files-header-root-browsing.md](./completed/2026-10-12-files-header-root-browsing.md) (Chinese) — Files-header root browsing: P1 moved an icon-only gear launcher ahead of reload, P2 upgraded it to a root switcher whose portal takes over the tree area, P3–P10 were visual-review fixes, and P11 replaced the self-drawn tree with a verbatim fork of upstream's Files tree (`src/client/files-tree/`, retiring the private `files`/`readFile` endpoints; implemented 2026-10-12, released with `v0.1.7`; see ADR-0015).

### Batch Numbering

- **M1–M4** are the MVP roadmap milestones (M4 = the cross-process lease).
- **H1–H4** are the `v0.1.1` hardening batch: H1 = M4, H2 = panel authority, H3 = the compatibility contract, H4 = additional-root instructions (Phase 1 top-level and Phase 2 nested are both done).
- **B-series** numbers identify second-phase tasks; B9's implementation phases do not receive separate B numbers.
- Single source of truth: the [roadmap progress ledger](./active/2026-09-12-multi-root-workspace.md#进度总账).

## Naming Convention

Use lowercase kebab-case, for example:

```text
YYYY-MM-DD-<short-title>.md
```

See the `.agent/templates/plan.md` template.
