# Architecture Decision Records

中文：[README.md](./README.md)

## What Belongs Here

Architecture Decision Records (ADRs), capturing important architecture and engineering decisions:

- Context;
- Decision;
- Alternatives;
- Consequences.

## What Does Not Belong Here

- Raw discussions or proposals not yet shaped into a reviewable ADR (an ADR with agreed product rules and an architecture awaiting validation may be marked Proposed);
- Day-to-day development plans (goes to `../plans/`).

## Current State

- [ADR-0001-provider-replacement-scope.md](./ADR-0001-provider-replacement-scope.md) — Replace only the `fs-sandbox` and `sandbox` provider rows (Accepted).
- [ADR-0002-upstream-coupling-policy.md](./ADR-0002-upstream-coupling-policy.md) — Upstream coupling policy: entry-point imports only, exact version pins, upgrade smoke tests (Accepted).
- [ADR-0003-dialect-grant-widening.md](./ADR-0003-dialect-grant-widening.md) — Dialect grant widening: structural recognition, observed cloning, skip-already-granted, fail loudly when unrecognized (Accepted).
- [ADR-0004-root-registry-persistence-and-validation.md](./ADR-0004-root-registry-persistence-and-validation.md) — The root registry: a canonical-primary-root-keyed domain KV, the validation order, nested roots rejected, missing roots withheld, an unreadable store degrading instead of blocking boot (Accepted).
- [ADR-0005-out-of-tree-client-transport.md](./ADR-0005-out-of-tree-client-transport.md) — The out-of-tree client half: a Connection RPC channel, a `sidebar.footer.action` panel, and the composed directory-picking capabilities — no Typert Remote namespace (Accepted).
- [ADR-0006-client-ui-host-tokens.md](./ADR-0006-client-ui-host-tokens.md) — The client UI replicates the host's native look: an injected stylesheet consuming the host's `--dsw-*` tokens, zero hardcoded colors in the plugin (Accepted; amended 2026-11-16: confirmation-layer `Modal` and transient `Toast` may be imported from primitives, decision 7).
- [ADR-0007-registry-authority-lease.md](./ADR-0007-registry-authority-lease.md) — Cross-process Registry Authority: a store-wide kernel lease, fail-closed on contention, takeover via `refresh()` (Accepted).
- [ADR-0008-panel-session-derived-authority.md](./ADR-0008-panel-session-derived-authority.md) — Panel primary root is derived from the host session cwd: no client `primaryRoot`, every endpoint requires a live `sessionId` (Accepted).
- [ADR-0009-dsh-compat-contract.md](./ADR-0009-dsh-compat-contract.md) — DSH compatibility as a code contract: an exact-version allowlist, the `multi-root-compat` startup gate, mixed installations failing loudly, the `src/compat/` adapter layer, and a weekly upgrade lane that never widens the matrix by itself (Accepted).
- [ADR-0010-additional-root-instruction-scope.md](./ADR-0010-additional-root-instruction-scope.md) — Additional-root instruction injection: top-level files plus those of the subdirectories the session has worked in, delivered as a user-role `form=instructions` message from `agent/pre-step`, one shared byte budget, explicit revocation on departure and withdrawal when a delivered file disappears (Accepted).
- [ADR-0011-multi-root-workspace-consumers.md](./ADR-0011-multi-root-workspace-consumers.md) — Public LSP routing, a Windows root-set SID runner, workspace-files isolation, and the additional-root file tree (Accepted).

- [ADR-0012-session-origin-and-effective-cwd.md](./ADR-0012-session-origin-and-effective-cwd.md) — Separates session origin from effective cwd, including LSP caller identity, instruction touches, Worktrees and process snapshots (Accepted).
- [ADR-0013-per-root-and-per-tool-access.md](./ADR-0013-per-root-and-per-tool-access.md) — Per-root read-write/read-only access with a downgrade-safe v1 persistence encoding, `setAccess` upgrade gating, the Windows root-set SID, and `toolAccess` per-tool caps via the AsyncLocalStorage dispatch context (Accepted).
- [ADR-0014-root-limit-and-provider-conflict.md](./ADR-0014-root-limit-and-provider-conflict.md) — A per-primary stored-record cap (default 16, ceiling 64, over-limit history keeps granting) and the `multi-root-providers` brand gate that fails closed when a foreign provider owns `ctx.fs`/`ctx.sandbox` (Accepted).
- [ADR-0015-files-tab-plugin-owned-browsing.md](./ADR-0015-files-tab-plugin-owned-browsing.md) (Chinese) — The Files-tab root switcher: the native tree cannot be retargeted, so the tree area is taken over through `createPortal` (now hosting a verbatim fork of upstream's Files tree under `files-tree/`), degrading silently when the `data-files-*` hooks stop matching (Accepted, amended 2026-10-12).
- [ADR-0016-files-tab-native-tree-fork.md](./ADR-0016-files-tab-native-tree-fork.md) (Chinese) — The additional-root tree becomes a verbatim fork of upstream's `ui-sidebar-files` tree body (rewritten shell for the root prop, `store`/`inject` declarations, `workspaceFiles` data path, private `files`/`readFile` endpoints retired), replacing the self-drawn `RootFileTree` (Accepted).
- [ADR-0017-three-state-root-access-and-sandbox-modes.md](./ADR-0017-three-state-root-access-and-sandbox-modes.md) (Chinese) — B9 three-state additional-root access (inherit/read-only/read-write) with the nine-cell matrix, the `readWriteRecordedPath` persistence encoding, consumer-side public-method seams for shell/pwsh/PTY/PTC (ALS + env session marker), per-dialect restricted profiles, and the Windows single-SID boundary (Accepted, Phase 1 decisions).
- [ADR-0018-windows-ambient-write-denial.md](./ADR-0018-windows-ambient-write-denial.md) (Chinese) — Windows ambient write denial for B9: restricted tokens, explicit ACLs, owner/parent/token bypass protection, standing ACEs, and partial enforcement boundaries (superseded by ADR-0019).
- [ADR-0019-windows-token-attributes-and-conditional-acls.md](./ADR-0019-windows-token-attributes-and-conditional-acls.md) (Chinese) — Replaces ADR-0018 with inherited mandatory local token attributes and conditional deny ACEs; narrowed token copies remain denied while PowerShell identity queries remain possible; native readback succeeded but local conditions did not enforce denial; ADR-0020 records the replacement candidate (Superseded).
- [ADR-0020-windows-normal-deny-groups.md](./ADR-0020-windows-normal-deny-groups.md) (Chinese) — Mirror the caller identity with additional normal deny-only groups and ordinary deny ACEs, retaining actual write attempts after token narrowing (Accepted).

Do not pre-create empty ADR files; add one only when a real decision is made.

## Naming Convention

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

Numbers increment and titles use lowercase kebab-case. ADR-0030–0034 are reserved for Issue #32, so the main line resumes at ADR-0035. After merging main, the SSH credential broker and custody modes use ADR-0048 and ADR-0049 (formerly 0040 and 0041 on this branch). Scan all branches for available numbers before adding an ADR.

- [ADR-0021-auto-review-context-companion.md](./ADR-0021-auto-review-context-companion.md) — Optional Auto Review companion, shared tool permission preview, current constraints, native overlap, fail-closed checks and fork synchronization (Accepted).

- [ADR-0022-auto-review-loader-entry.md](./ADR-0022-auto-review-loader-entry.md) (Chinese) — Auto Review in the main package: one default-disabled Loader row, runtime takeover, in-flight import suppression, ordered owner handover, and a single package build; replaces ADR-0021's delivery structure.

- [ADR-0023-multi-root-skill-discovery-and-invocation.md](./ADR-0023-multi-root-skill-discovery-and-invocation.md) (Chinese) — Additional-root Skills: access-based defaults, aliasId namespaces, trusted Session scopes, native internal-ID bridging, effective-cwd discovery routing, Settings and migration boundaries (Accepted architecture; feature implementation pending).

- [ADR-0024-registry-operation-admission.md](./ADR-0024-registry-operation-admission.md) — Ordered operation admission and revocation; admitted work may finish (Accepted).

- [ADR-0025-shared-registry-authority.md](./ADR-0025-shared-registry-authority.md) — Shared authority service, authenticated IPC, synchronous consumer contracts and fail-closed takeover (Accepted).

- [ADR-0026-registry-background-recovery.md](./ADR-0026-registry-background-recovery.md) (Chinese) — Registry authority background recovery and diagnostics: structured retry eligibility, scheduler invariants, projection-sync completion, scope truth signatures and commit notification atomicity, local handshake cancellation, and a diagnostics surface (Accepted contract; implementation pending).

- [ADR-0027-revive-target-and-protected-paths.md](./ADR-0027-revive-target-and-protected-paths.md) (Chinese) — Revive never changes the grant target; registration boundary and stored-record withholding for `$DSH_HOME`, the Registry medium and the lease directory (Accepted, P1 contract).

- [ADR-0028-upstream-primary-identity-and-shared-only-registry.md](./ADR-0028-upstream-primary-identity-and-shared-only-registry.md) (Chinese) — Primary-root identity is the upstream spelling (MRW-01), denies win over the primary root; the Registry keeps only the shared mode (Accepted).

- [ADR-0029-ops-file-authorization-and-activity-adapter.md](./ADR-0029-ops-file-authorization-and-activity-adapter.md) (Chinese) — Accepted only for experimental safeguards, Phase-A live activity, and bounded Review. Remaining P5 compatibility recovery is deferred indefinitely and excluded from this final acceptance.

- [ADR-0035-unadmitted-confined-spawn.md](./ADR-0035-unadmitted-confined-spawn.md) (Chinese) — Unadmitted confined spawn: a minted-profile ledger (dispatch-time publication generation, process-local, expired frames never recorded) restores the documented primary-root-only degrade, and reachable foreign-service entries (forgePanel/worktrees) still take real admission; the OPS domain and protection window stay strict toward ledger mints (Accepted).

- [ADR-0036-approved-escalation-override.md](./ADR-0036-approved-escalation-override.md) (Chinese) — A user-approved one-shot `danger-full-access` escalation lifts the read-only-root and per-tool-cap refusals for that call only (`$DSH_HOME` and unavailable authority excepted); standing Full-access, nested/later calls, and OPS dispatches are unaffected (Accepted).

- [ADR-0037-conversation-hero-workspace-folders-entry.md](./ADR-0037-conversation-hero-workspace-folders-entry.md) (Chinese) — An incremental Workspace Folders entry on the New Session hero row: a `conversation.hero.options` registration (`0.2.1-alpha.3+`), the adjacent selectors' geometry without a chevron, and session authority from the slot props; the sidebar `Folders` entry remains and its retirement is deferred. **Amended 2026-11-14**: `.heroOptions` is `flex: none`, so the entry now measures the room the row leaves and clamps itself into it (icon-only under 88px); the viewport step survives only as the probe's fallback (Accepted; implemented and verified).

- [ADR-0038-workspace-menu-folders-dialog.md](./ADR-0038-workspace-menu-folders-dialog.md) (Chinese) — The "Manage workspace folders…" entry in the workspace `...` menu: an apply-scoped dialog controller reuses the footer dialog, opening it directly when the current session already belongs to the target workspace and otherwise switching through `uiWorkspace.openWorkspace` and confirming the new current session; missing services disable the entry, and `RootSwitcher` stays untouched (Accepted; implementation in the plan).

- [ADR-0039-worktree-aware-root-suggestions.md](./ADR-0039-worktree-aware-root-suggestions.md) (Chinese) — Worktree root suggestions and manual cleanup (B), followed by explicit access to shared Git metadata for linked worktrees (A). Both use an experimental plugin setting that defaults to off. Accepted, revision 26 (2026-11-16); the panel cleanup confirmation, the `cleanupEligible` badge/subrow presentation, and the path-reuse notice location are provisionally superseded by [ADR-0045](./ADR-0045-worktree-cleanup-panel-ui.md) (Proposed, effective once accepted). Implementation status is tracked in the roadmap.

- [ADR-0040-auto-review-multi-baseline.md](./ADR-0040-auto-review-multi-baseline.md) (Chinese) — The optional Auto Review joint contract grows from one exact release to two source baselines covering nine exact releases: per-baseline verbatim forks, lane-scoped dynamic loading, implementation typechecking at each baseline's compile pin, the alpha.2 request-identity exception, and the constraint insertion position (Accepted; amends the single-baseline conclusions of ADR-0021/0022).

- [ADR-0041-additional-root-workspace-search.md](./ADR-0041-additional-root-workspace-search.md) (Chinese) — Workspace search for an additional root: because the upstream wire cannot name a root, the plugin channel gains a `search` endpoint (the `rootId` is resolved from a refreshed Registry, authorization takes one primary-root admission and re-checks the grant inside the frame); the client gates on `workspaceFiles.search`, keeps one record per (tab, root) in the inject product, and stores preferences under the upstream localStorage key; older hosts are unaffected (Accepted; implementation in the plan).

- [ADR-0042-additional-root-row-context-menus.md](./ADR-0042-additional-root-row-context-menus.md) (Chinese) — Additional-root Files row context menus and viewer greying: the root-level `useContextMenu` is read structurally and `rowTriggerProps`/`canOpen` are forwarded into the host Factory (the legacy rows behave the same), with absolute paths as targets; no `ui-context-menu` dependency (the upgrade matrix rewrites devDependencies and would break older lanes' installs) (Accepted; implementation in the plan).

- [ADR-0043-additional-root-preview-navigator-search.md](./ADR-0043-additional-root-preview-navigator-search.md) (Chinese) — Workspace search in the document preview's Folder navigator for additional roots: reuses ADR-0041's `search` endpoint and the Files-page search surface (`FilesPane` gains a preview mode) to replace the native search bar whose root is fixed to the Session cwd; result current-row marking, hidden-entry default, settings refocus, and focus handoff align with the native preview; the same change fixes the `RootSwitcher` root-switch transition-frame defect; older hosts and the primary root stay unchanged (Accepted; external review F1–F3 incorporated 2026-11-16; implementation in the plan).
- [ADR-0044-sidebar-footer-row-alignment-and-coexistence.md](./ADR-0044-sidebar-footer-row-alignment-and-coexistence.md) (Chinese) — The sidebar footer entry switches to the workspace-tree glyph; one recipe (host tokens with legacy fallbacks) aligns both the 19 legacy-geometry releases and the 5 token-geometry releases (boundary `0.2.2-alpha.2`); rail rounding follows its own earlier boundary `0.1.6-alpha.2` (22 of 24 releases aligned; the two oldest are a documented deviation); while this entry is mounted the `sidebar.footer.action` slot anchor becomes a vertical column so a second footer action gets its own full row (no hiding, no slot-ledger reads, no changes to other entries; the rejected yield design and its rationale are in the ADR); revision A makes the button height follow the visible settings-row occupant (account launcher 32 signed out / 44 signed in from `0.2.0-rc.1`, 42px fallback on older hosts, 36px rail) so both footer hover pills are the same size (Accepted; implementation in the plan).

- [ADR-0046-files-header-rootswitch-shrink-priority.md](./ADR-0046-files-header-rootswitch-shrink-priority.md) (Chinese) — Shrink priority for the Files header's `RootSwitcher`: the shrink capability has to live on the `Menu` anchor wrapper that is the header row's outer flex item (`min-width: 0`); the fixed controls never move, the full path yields first through a zero flex basis, the root name ellipsizes next, and the trigger's own icons clip last. It replaces the ineffective "put `min-width: 0` on the inner button only" writing; `Menu.className` was checked against all 24 supported releases, so no version branch is needed (Accepted; implementation in the plan).

- [ADR-0045-worktree-cleanup-panel-ui.md](./ADR-0045-worktree-cleanup-panel-ui.md) (Chinese) — Workspace Folders panel cleanup UX: the batch cleanup entry moves to the Additional roots section header, the confirmation becomes a primitives `Modal` layered over the panel, `cleanupEligible` rows keep only title/access/path plus a red delete and `...` (skills/reveal/re-register and inline status text removed; the path-reuse disclosure moves into the confirmation), and an empty manual discovery shows the official info Toast; supersedes ADR-0039's deletion badge presentation under §3.2 (cleanupEligible rows only), its §6.2 badge/subrow presentation and confirmation form, its path-reuse notice location, and its cleanup-overlay rejection (Proposed; external technical review passed on 2026-11-16 with no blockers; moving to Accepted is the maintainer's decision).

## Issue #32 · Multi-environment workspace decisions

- [ADR-0030](./ADR-0030-environment-and-root-identity.md) — Environment identity, root grants and ordered admission in one session (Accepted).
- [ADR-0031](./ADR-0031-filesystem-routing.md) — One filesystem entry point and environment-aware consumers (Accepted).
- [ADR-0032](./ADR-0032-upstream-ssh-backend.md) — Reusing the upstream SSH providers, with distribution and platform evidence (Accepted).
- [ADR-0033](./ADR-0033-remote-command-and-sandbox.md) — Explicit remote commands, sandbox guarantees and cancellation (Accepted).
- [ADR-0034](./ADR-0034-binary-transfer.md) — Authorization, publication and failure semantics for binary transfers (Accepted).
- [ADR-0048](./ADR-0048-credential-broker.md) — A local credential broker holding SSH connections under a dedicated OS account, with kernel authentication and attestation conditions (Proposed).
- [ADR-0049](./ADR-0049-ssh-custody-modes.md) — Three SSH credential custody tiers: personal (the upstream SSH stack in the Host process on the user's own credentials), team (broker custody with relaxed deployment evidence), hardened (the full ADR-0048 evidence path) (Accepted).
- [ADR-0051](./ADR-0051-ssh-stream-psk-boringssl-fallback.md) (Chinese) — BoringSSL PSK fallback for SSH forwarded streams: the Host rewrites only the upstream stream call's exact option shape, the plugin adds a `helper-entry-v3.mjs` that widens the server list with ChaCha20-PSK, and the recorded `integrity`/`helperPath`/`bindingDigest` stay unchanged; the stream stays PSK-only (Accepted).
- [ADR-0050](./ADR-0050-add-affordance-and-wizard-kit.md) (Chinese) — The workspace panel footer collapses to a single `+` button with two shapes driven by the remote-tools switch, a trust-confirmation dialog for local additions, and the `src/client/wizard/` design kit reserved for migrating the legacy SSH dialogs (Accepted).
- [ADR-0052](./ADR-0052-provider-file-browsing.md) (Chinese) — Provider-dispatched file-tree browsing: a `RootRef` discriminated union plus `{root, relativePath}` node identity replaces path spelling (the display path is metadata only), state keys carry the authorization incarnation, the local API spelling is preserved through the adapter and remote synthetic tree keys are never used as local paths; the host gains an independent `remoteFiles.list` under an explicitly UI-read-only admission ordered before and after network I/O, the SFTP path backend is admitted only under a documented isolation condition and never for Helper object grants, and Helper (no fd-bound listing) and Broker (no directory stream) fail closed (Proposed).
- [ADR-0053](./ADR-0053-provider-remote-file-preview.md) (Chinese) — Provider-dispatched remote file preview: SSH file rows route through the optional `preview` port to the plugin-owned opaque Resource (`dsh-resource://mrfw-remote/<uuid v4>`) and a capability-gated read-only Viewer; one strict `remoteFiles.read` over a Connection binary attachment; an independent `filePreview:'stable-path'` opt-in limited to personal-custody SFTP and initially to `0.2.3-alpha.2`; temp files, Viewer forks, new transports/credentials, budget bypass and Base64 payloads rejected (Proposed).
