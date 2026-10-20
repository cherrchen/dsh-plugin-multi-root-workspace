# Architecture Decision Records

中文：[README.md](./README.md)

## What Belongs Here

Architecture Decision Records (ADRs), capturing important architecture and engineering decisions:

- Context;
- Decision;
- Alternatives;
- Consequences.

## What Does Not Belong Here

- Discussions or proposals that have not become decisions;
- Day-to-day development plans (goes to `../plans/`).

## Current State

- [ADR-0001-provider-replacement-scope.md](./ADR-0001-provider-replacement-scope.md) — Replace only the `fs-sandbox` and `sandbox` provider rows (Accepted).
- [ADR-0002-upstream-coupling-policy.md](./ADR-0002-upstream-coupling-policy.md) — Upstream coupling policy: entry-point imports only, exact version pins, upgrade smoke tests (Accepted).
- [ADR-0003-dialect-grant-widening.md](./ADR-0003-dialect-grant-widening.md) — Dialect grant widening: structural recognition, observed cloning, skip-already-granted, fail loudly when unrecognized (Accepted).
- [ADR-0004-root-registry-persistence-and-validation.md](./ADR-0004-root-registry-persistence-and-validation.md) — The root registry: a canonical-primary-root-keyed domain KV, the validation order, nested roots rejected, missing roots withheld, an unreadable store degrading instead of blocking boot (Accepted).
- [ADR-0005-out-of-tree-client-transport.md](./ADR-0005-out-of-tree-client-transport.md) — The out-of-tree client half: a Connection RPC channel, a `sidebar.footer.action` panel, and the composed directory-picking capabilities — no Typert Remote namespace (Accepted).
- [ADR-0006-client-ui-host-tokens.md](./ADR-0006-client-ui-host-tokens.md) — The client UI replicates the host's native look: an injected stylesheet consuming the host's `--dsw-*` tokens, zero hardcoded colors in the plugin (Accepted).
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

Numbers increment; titles use lowercase kebab-case.

- [ADR-0021-auto-review-context-companion.md](./ADR-0021-auto-review-context-companion.md) — Optional Auto Review companion, shared tool permission preview, current constraints, native overlap, fail-closed checks and fork synchronization (Accepted).

- [ADR-0022-auto-review-loader-entry.md](./ADR-0022-auto-review-loader-entry.md) (Chinese) — Auto Review in the main package: one default-disabled Loader row, runtime takeover, in-flight import suppression, ordered owner handover, and a single package build; replaces ADR-0021's delivery structure.
