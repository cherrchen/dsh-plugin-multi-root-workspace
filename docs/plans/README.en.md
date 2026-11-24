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












- [Issue #32 implementation and verification plan](./active/2026-11-06-multi-environment-gates.md) (Chinese) — Passed external technical review; in progress: the personal SSH tier is implemented and released in the `v0.1.24-beta` line (experimental, off by default) while the team and hardened broker tiers stay disabled. Covers PR dependencies, implementation details, fault injection and rollback.


- [2026-10-30-shared-registry-authority.md](./active/2026-10-30-shared-registry-authority.md) (Chinese) — Full original Long-term scope for Issue #24, comparison of the released baseline and the initial shared-service commit, six P1 audit items, and future evolution with exit criteria; the initial version is released with `v0.1.12`, and the remaining Ubuntu report-environment soak retest plus progress stay in the roadmap ledger.


- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace development path and **progress ledger**: the MVP `v0.1.0` milestones M1/M2/M3 are implemented and released; the `v0.1.1` hardening batch H1–H4 is implemented and released with `v0.1.1`; the `v0.1.2` support-matrix expansion is implemented and released with `v0.1.2`; the `v0.1.3` support-matrix expansion (`0.1.7-alpha.2` / `0.1.7-rc.1`) is implemented and released with `v0.1.3`; the `v0.1.4` support-matrix expansion (`0.1.7-rc.2`) is implemented and released with `v0.1.4`; `v0.1.5` (DSH `0.2.0-rc.1` / `.2`) is released; `v0.1.6` (DSH `0.2.1-alpha.1` / `.2`, B1–B3, and dynamic cwd) is released; `v0.1.7` (the second-phase B batches, Files-tab additional-root browsing, and DSH `0.2.1-alpha.3`–`0.2.1-rc.2`) is released; `v0.1.8` (the DSH 0.2.0 `permissionPresets/catalog` fix) is released; `v0.1.9` (the optional in-package Auto Review entry) is released; `v0.1.10` (additional-root Skills, the Workspace Folders panel alignment, and DSH `0.2.1-rc.3`) is released; `v0.1.11` (DSH `0.2.1-rc.4` and `0.2.2-alpha.2` compatibility plus the Issue #24 Registry/Skills refresh-loop hot-fix) is released; `v0.1.12` (the shared multi-Host registry authority, per-operation admission, and DSH `0.2.1-rc.5`) is released; `v0.1.13` ships F4 background recovery and the Files-tab root-selection fix; `v0.1.14` ships the Issue #30 dependency-singleton fix with host-anchored koffi, DSH `0.2.2-alpha.3`/`0.2.2-rc.1` compatibility, and the plugin-detail settings-card Auto Review toggle plus rich detail page; `v0.1.15` ships the `/add-dirs` alias, root-authorization security fixes, and default-off experimental OPS safeguards with activation risk confirmation; `v0.1.16` ships the unadmitted confined-spawn fix, the panel's persisted-but-not-live session classification, and the preview Folder navigator's additional-root retarget; `v0.1.17` ships experimental worktree root suggestions with linked-worktree main-checkout authorization, the New Session hero and workspace `...` menu Workspace Folders entries, and the approved one-shot Full-access escalation override; `v0.1.18` ships exact support for DSH `0.2.2-rc.2`, with Files-tab search brought under the shared admission and root boundary; `v0.1.19` ships exact support for DSH `0.2.2-rc.3` (24 exact releases in the contract). `v0.1.20` ships additional-root Files row menus and workspace search, optional Auto Review joint support across two generations and nine exact releases, the worktree notice and confirmation Dialog rebuild, and the New Session hero entry's adaptive width. `v0.1.21` ships the document-preview navigator's additional-root workspace search, the Files-page takeover notice, host-provided `koffi`, the worktree close control and cleanup-panel UX convergence, and the sidebar footer entry's host-row alignment and same-slot coexistence. `v0.1.22` ships the Files header `RootSwitcher`'s narrow-width shrink order with the three-tier root name, and exact support for DSH `0.2.2-rc.4`. `v0.1.23` ships eight-language panel and detail localization, the eight-language root README with per-feature user guides, contribution and security governance, and exact support for DSH `0.2.2-rc.5`. `v0.1.24-beta.1` ships the personal SSH remote environments (experimental, off by default) and the Workspace Folders additional-root list scroll fix. `v0.1.24-beta.2` ships the SSH dependency repair guidance and Helper installation diagnostics. `v0.1.24-beta.3` ships the BoringSSL PSK fallback for forwarded SSH streams. `v0.1.24-beta.4` ships the Host-exit fix for uninstalling the plugin with a live SSH connection, the SSH dependency install command shipped with the package, and the one-click Desktop install entry. `v0.1.24-beta.5` ships the personal SSH tool hardening: one `remote_copy` endpoint declaration with early argument validation, actionable failure guidance with endpoint candidates, and a `remote_bash` output budget with byte counts. `v0.1.24-beta.6` ships exact support for DSH `0.2.3-alpha.2` (27 exact releases) with the Session-origin identity split, the client fork re-sync, the dual-cordis Auto Review root probe, and Node `24.22.3` lanes. `v0.1.24` is the first stable of the `0.1.24` line and graduates all six betas.


completed:

- [2026-11-23-remote-tool-hardening.md](./completed/2026-11-23-remote-tool-hardening.md) (Chinese) — personal SSH tool hardening: one endpoint definition for both `remote_copy` sides (only an omitted `environmentId` defaults to `local`; `null`/empty is rejected), execute-boundary `invalid-arguments` from the same declaration the tool advertises, bounded `message`/`hint` and bounded endpoint candidates generated from stable codes, a 64 KiB per-stream `remote_bash` preview default with `maxOutputBytes`/`totalBytes`/`droppedBytes`, and the transfer properties (single regular file, 0600, no mtime preservation, no overwrite) plus recorded follow-ups; merged into `main` (PR #78) and released with `v0.1.24-beta.5`.

- [2026-11-22-remote-copy-stream-budget.md](./completed/2026-11-22-remote-copy-stream-budget.md) (Chinese) — PR #73 Codex review P2: both upload paths of `remote_copy` compared `maxBytes` only while binding the source, so a source that grew after its stat pushed the excess into remote staging first and only then failed as `source-changed`; the fix enforces the cumulative budget before each staging write (`transfer-too-large`), shared by both upload loops, with red/green regressions and exit acceptance; merged into `main` with PR #73 and released with `v0.1.24-beta.1`.

- [SSH 环境与 Workspace Root 绑定拆分](./completed/2026-11-20-ssh-environments-and-workspace-bindings.md) (Chinese) — Separates SSH environment management from Workspace Root binding, with legacy migration and same-environment multi-Root coverage.

- [2026-11-19-ssh-add-connection-two-step.md](./completed/2026-11-19-ssh-add-connection-two-step.md) (Chinese) — Historical two-step wizard, superseded by separate connection and binding flows.

- [2026-11-17-files-rootswitch-narrow-width.md](./completed/2026-11-17-files-rootswitch-narrow-width.md) (Chinese) — Shrink priority for the Files header's `RootSwitcher`: the `Menu` anchor wrapper span is the outer flex item, and without `min-width: 0` it pins the trigger at its min-content width, overflowing over the reload, search, and open-in-app controls in a narrowed sidebar, a two-column sidebar, and a resized floating pane. The fix gives the fixed controls, the full path, the root name, and the trigger icons a strict yield order (unpin the anchor, a zero-basis path that yields first, and a clipped trigger); completed 2026-11-17 with focused and full client tests plus isolated Web-host DOM measurements and screenshots for panes at 299/323/220 and the additional-root takeover. A follow-up (P5) adds the three-tier root name display — full name, then head and tail (word-aligned where possible), then the head alone — with pure fit/measurement modules and per-tier real-GUI evidence. Decision in [ADR-0046](../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md).

- [2026-11-16-sidebar-footer-row-alignment-and-coexistence.md](./completed/2026-11-16-sidebar-footer-row-alignment-and-coexistence.md) (Chinese) — The sidebar footer entry's workspace-tree glyph and its geometry across both host generations (19 legacy / 5 token releases, boundary `0.2.2-alpha.2`; rail rounding follows its own earlier `0.1.6-alpha.2` boundary, 22 of 24 releases aligned with the two oldest as a documented deviation), plus the vertical-coexistence rule that gives a second footer action its own row: one token-plus-fallback CSS recipe, a `:has()`-scoped vertical slot anchor, and no hiding, slot-ledger reads, or edits to other entries. Includes the replicated-layout evidence, tests, and the documentation list. Implemented and released with `v0.1.21` (PR #63); decision in [ADR-0044](../decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md).

- [2026-11-16-additional-root-preview-navigator-search.md](./completed/2026-11-16-additional-root-preview-navigator-search.md) (Chinese) — Workspace search in the document preview's Folder navigator (the FileTree beside a preview) when the previewed file sits under an additional root: reuses the existing `search` endpoint and `FilesPane` (new preview mode), adds result current-row marking, hidden-entry default, settings refocus, focus handoff, Escape ordering, and old-host degradation; available from DSH `0.2.2-rc.2`, with no Host changes. Implemented and released with `v0.1.21` (PR #65); decision in [ADR-0043](../decisions/ADR-0043-additional-root-preview-navigator-search.md).

- [2026-11-16-worktree-cleanup-panel-ux.md](./completed/2026-11-16-worktree-cleanup-panel-ux.md) (Chinese) — Workspace Folders panel cleanup UX (R1–R4), implemented and accepted on 2026-11-16: the batch cleanup entry moves to the Additional roots section header, the confirmation becomes a primitives `Modal` layered over the panel, `cleanupEligible` rows collapse to title/access/path plus a red delete and `...`, and an empty manual discovery shows the official info Toast. A client-presentation-only change with no authorization/protocol/host changes. Evidence in the [roadmap ledger](./active/2026-09-12-multi-root-workspace.md#worktree-清理面板-ux-收敛2026-11-16); decision in [ADR-0045](../decisions/ADR-0045-worktree-cleanup-panel-ui.md).

- [2026-11-15-files-page-takeover-notice.md](./completed/2026-11-15-files-page-takeover-notice.md) (Chinese) — Issue #47, scoped: when a third-party extension takes over the whole Files page, show one official transient Toast (info level, no warning glyph, gone in seconds). Detection reads the effective definition from `sidebarRightTabs.get('files')` instead of `slots.inject`/`spec`; no dialog/command copy and no fallback entry; includes entry and exit acceptance gates. Implemented and released with `v0.1.21` (PR #61); decision in [ADR-0015](../decisions/ADR-0015-files-tab-plugin-owned-browsing.md#修订files-页被整页接管时的可见提示2026-11-15).

- [2026-11-15-worktree-toast-close.md](./completed/2026-11-15-worktree-toast-close.md) (Chinese) — Reinstates the close control the earlier plan removed: a perfect-circle × whose center sits on the notice card's top-right corner and may overhang the card. It closes only — no `snooze`/`resolve`, no reminder state — and the `seen` claim keeps this Host quiet until it restarts. Implemented and released with `v0.1.21` (PR #62); decision in [ADR-0039 第二十五次修订](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十五次修订2026-11-15).

- [2026-11-15-workspace-toast-implementation.md](./completed/2026-11-15-workspace-toast-implementation.md) (Chinese) — Final implementation plan and exit acceptance for the worktree suggestion notice: Hero top-center and conversation centered below the Header, a theme-adaptive light/dark card, no close button (the Remind me later menu dismisses it), primitives controls, a two-row coarse-pointer form, and avoidance of the upstream transient Toast. Implemented and released with `v0.1.20` (PR #60); the close-button removal was later reverted by 2026-11-15-worktree-toast-close.md. Decision in [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十一次修订2026-11-15).

- [2026-11-15-workspace-toast-placement.md](./completed/2026-11-15-workspace-toast-placement.md) (Chinese) — Requirement sync, current-defect analysis (composer occlusion, mixed control language, a11y, floating-surface recipe), and the initial redesign proposal; reviewed on 2026-11-15 and shipped with `v0.1.20`.

- [2026-11-15-worktree-dialog-redesign.md](./completed/2026-11-15-worktree-dialog-redesign.md) (Chinese) — Widens the worktree confirmation dialog, turns candidates into a continuous list, removes the inherit paragraph, adds a per-row access selector (default inherit, with a new `accesses` contract and Registry grant), shows the detected Git branch, and moves the footer to primitives. Implemented and released with `v0.1.20`; decision in [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十二次修订2026-11-15).

- [2026-11-15-worktree-review-fixes.md](./completed/2026-11-15-worktree-review-fixes.md) (Chinese) — PR #60 review fixes: the follower `addNew` IPC accepts `read-only`/`read-write`, the Files manager forwards the worktree manual-entry props, and reused candidate records refresh the main checkout's displayed branch (`mainHead` still never participates in authorization); includes the verification ledger and the exit acceptance mechanism. Implemented and released with `v0.1.20`.

- [2026-11-14-auto-review-multi-baseline.md](./completed/2026-11-14-auto-review-multi-baseline.md) (Chinese) — The optional Auto Review joint contract grows from one baseline to two source baselines covering nine exact releases: per-baseline verbatim forks, lane-scoped dynamic loading, compile-pin typechecking, cross-generation tests/smoke/CI gates, and documentation. Completed and accepted on the development pin and the baseline-A lane; decision in [ADR-0040](../decisions/ADR-0040-auto-review-multi-baseline.md).

- [2026-11-14-hero-entry-adaptive-width.md](./completed/2026-11-14-hero-entry-adaptive-width.md) (Chinese) — The New Session hero entry now fits the room the row leaves for it: a probe measures that room, `max-width` clamps to it, and under 88px the entry degrades to a 28×28 icon. No DSH change; an unrecognized row structure falls back to the `v0.1.19` form. Implemented and released with `v0.1.20` (PR #53); decision amendment in [ADR-0037](../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md).

- [2026-11-13-ssh-management-dialog.md](./completed/2026-11-13-ssh-management-dialog.md) (Chinese) — Extracts the inline SSH management from the Workspace Folders panel into a standalone four-tab dialog (Add connection / Connections / SSH keys / Mode), leaving the Workspace Folders panel with only the remote-workspace list and Add/Manage entries; platforms display as Linux / macOS and the custody mode drives the Add guidance. Completed 2026-11-13: local static gates, smokes, and feature specs passed, and [CI run 43447653166](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43447653166) ended with 26/26 jobs successful. The follow-up UI-control fix ran the local gates only; CI was deliberately not re-triggered per the maintainer's instruction.

- [2026-11-09-worktree-aware-root-suggestions.md](./completed/2026-11-09-worktree-aware-root-suggestions.md) (Chinese) — P1–P7 cover worktree root suggestions, the plugin toggle, and manual cleanup (B). P8–P10 add explicit access to shared Git metadata for linked worktrees (A). Revision 19 adds the single/multi-candidate notice split, and revisions 20–25 converge automatic discovery to one read-only check per session activation and rebuild the notice and confirmation Dialog. See [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md) for the decision; implemented, with the revisions shipped across `v0.1.17`–`v0.1.21`.

- [2026-11-08-workspace-menu-folders-dialog.md](./completed/2026-11-08-workspace-menu-folders-dialog.md) (Chinese) — A "Manage workspace folders…" entry in the workspace `...` menu: a controller reusing the footer dialog, a `workspace` context-menu contribution (order 150), and switching/reusing the target workspace's blank session before opening with that fixed session; `RootSwitcher` and upstream `WorkspaceBrowser` stay untouched. Implemented and released with `v0.1.17` (decision in [ADR-0038](../decisions/ADR-0038-workspace-menu-folders-dialog.md)).

- [2026-11-08-workspace-folders-hero-entry.md](./completed/2026-11-08-workspace-folders-hero-entry.md) (Chinese) — An incremental Workspace Folders entry on the New Session hero row: a `conversation.hero.options` registration, the adjacent selectors' geometry without a chevron, and a `≤560px` viewport icon-only degrade; the sidebar entry remains. Completed 2026-11-08 and passed the full gate, shipping in `v0.1.17`; decision: [ADR-0037](../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md).

- [2026-11-05-root-authorization-security-fixes.md](./completed/2026-11-05-root-authorization-security-fixes.md) (Chinese) — Completed bounded root-authorization fixes: BYP-02, MRW-01, protected-directory registration, and required shared mode. Excluded work remains out of scope; evidence and release status live in the [progress ledger](./active/2026-09-12-multi-root-workspace.md#进度总账).

- [2026-11-01-ops-compatibility-adaptation.md](./completed/2026-11-01-ops-compatibility-adaptation.md) (Chinese) — Bounded P0–P6 implementation and final acceptance of experimental OPS safeguards; P5 compatibility recovery is deferred indefinitely, with the feature off by default. Status and evidence are in the progress ledger.

- [2026-10-31-f4-background-recovery.md](./completed/2026-10-31-f4-background-recovery.md) (Chinese) — F4 background-recovery and diagnostics plan (rev.4 review passed, adopted via ADR-0026): a recovery scheduler reusing `ensureAuthority`, a projection-sync completion contract, atomic failed-round publication (including scope-subscriber batching), local handshake cancellation, and a diagnostics surface. Implemented and accepted on three-platform CI and released with `v0.1.13`; the real-TUI soak stays deferred, with the residual acceptance tracked by [2026-10-30-shared-registry-authority.md](./active/2026-10-30-shared-registry-authority.md).

- [2026-10-23-multi-root-skills.md](./completed/2026-10-23-multi-root-skills.md) (Chinese) — S1–S7 dependencies, tasks and exit criteria for ADR-0023: Registry, Session discovery and native cwd bypass prevention, on-demand invocation, caching/RPC, Web/Settings, and full release validation; implemented and released with `v0.1.10`, evidence in the roadmap ledger.
- [2026-10-20-auto-review-in-package-review.md](./completed/2026-10-20-auto-review-in-package-review.md) (Chinese) — Requirements review for moving Auto Review into the main package: feasibility, minimal loader probes, takeover and restoration boundaries, proposed contract, and acceptance criteria; implemented and released with `v0.1.9`.
- [2026-10-18-auto-review-context-adaptation.md](./completed/2026-10-18-auto-review-context-adaptation.md) (Chinese) — Phase 0–2 implementation plan: the explicit companion fork, shared permission preview, current constraints, joint verification, and migration to a formal upstream API; status and evidence belong to the roadmap ledger.
- [2026-10-16-branch-security-review-and-hardlink-isolation.md](./completed/2026-10-16-branch-security-review-and-hardlink-isolation.md) (Chinese) — Branch review evidence and proposed fixes for deny boundaries, ancestor renames on Windows, and pnpm hard-link isolation; Phases A (R2/R3 negative authorization), B (R1 ancestor pinning), C1 (all-root hardlink preflight) and C2 (the `/workspace-folders isolate-profiles` command, migration and smokes) are implemented and accepted, released with `v0.1.7`.

- [2026-10-13-b9-root-access-and-sandbox-modes.md](./completed/2026-10-13-b9-root-access-and-sandbox-modes.md) (Chinese) — B9 implementation plan: inherited, read-only, and read-write additional-root policies enforced across SandboxMode values, covering migration, process entry points, native backend feasibility, and acceptance checks. Progress and release state belong to the progress ledger.
- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 development plan: bundle skeleton, two-row provider replacement, empty-root pass-through (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 development plan: dialect grant widening, the parity matrix, the topology snapshot, and the multi-root smoke battery (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 development plan: the root registry and its persistence, the `/workspace-folders` command, the browser Folders panel, and the cross-repository journey e2e (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — `v0.1.1` batch H1 (roadmap M4): the cross-process Registry Authority Lease (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-panel-session-derived-authority.md](./completed/2026-09-15-panel-session-derived-authority.md) — `v0.1.1` batch H2: panel primary root derived from the host session, the client `primaryRoot` field removed (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-dsh-compat-contract.md](./completed/2026-09-15-dsh-compat-contract.md) — `v0.1.1` batch H3 + H4 Phase 1: DSH compatibility becomes a code contract enforced at startup, bringing `0.1.6-alpha.1` and top-level additional-root instruction injection in with it (implemented 2026-09-15, released with `v0.1.1`).
- [2026-09-15-v0.1.1-review-rework.md](./completed/2026-09-15-v0.1.1-review-rework.md) — pre-release rework for PR #1 on the `v0.1.1` batch (2 P1 + 3 P2 findings): authority teardown order (drain → close → release), intermediate-directory instructions becoming reachable, `warn` relaxing `unsupported` only, both optional peers loaded on demand, and absence separated from evaluation failure (implemented 2026-09-15, released with `v0.1.1`).
- [2026-10-12-files-header-root-browsing.md](./completed/2026-10-12-files-header-root-browsing.md) (Chinese) — Files-header root browsing: P1 moved an icon-only gear launcher ahead of reload, P2 upgraded it to a root switcher whose portal takes over the tree area, P3–P10 were visual-review fixes, and P11 replaced the self-drawn tree with a verbatim fork of upstream's Files tree (`src/client/files-tree/`, retiring the private `files`/`readFile` endpoints; implemented 2026-10-12, released with `v0.1.7`; see ADR-0015).

- [2026-10-11-b4-b8-p2.md](./completed/2026-10-11-b4-b8-p2.md) (Chinese) — Second-phase P2 hardening (B4–B8): per-root / per-tool access (`recordedPath` / `readOnlyRecordedPath`), reclassification before every mutation, the stored-root cap (default 16, ceiling 64), a fail-closed gate for foreign `ctx.fs`/`ctx.sandbox` providers, and a platform-aware topology prompt; includes three review rework rounds and cross-platform CI acceptance, released with `v0.1.7`. Decisions in [ADR-0013](../decisions/ADR-0013-per-root-and-per-tool-access.md) and [ADR-0014](../decisions/ADR-0014-root-limit-and-provider-conflict.md).

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
