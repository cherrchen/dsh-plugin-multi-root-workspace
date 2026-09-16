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

Do not pre-create empty ADR files; add one only when a real decision is made.

## Naming Convention

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

Numbers increment; titles use lowercase kebab-case.
