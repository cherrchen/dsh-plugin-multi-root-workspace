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

Do not pre-create empty ADR files; add one only when a real decision is made.

## Naming Convention

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

Numbers increment; titles use lowercase kebab-case.
