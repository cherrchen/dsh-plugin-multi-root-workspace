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

- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace development path and **progress ledger**: the MVP `v0.1.0` milestones M1/M2/M3 are implemented and released; the `v0.1.1` hardening batch H1–H4 is implemented but not yet released; the second phase (the B series) is scoped in requirements §4/§7.

completed:

- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 development plan: bundle skeleton, two-row provider replacement, empty-root pass-through (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 development plan: dialect grant widening, the parity matrix, the topology snapshot, and the multi-root smoke battery (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 development plan: the root registry and its persistence, the `/workspace-folders` command, the browser Folders panel, and the cross-repository journey e2e (implemented and verified 2026-09-12, released with `v0.1.0`).
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — `v0.1.1` batch H1 (roadmap M4): the cross-process Registry Authority Lease (implemented 2026-09-15, unreleased).
- [2026-09-15-panel-session-derived-authority.md](./completed/2026-09-15-panel-session-derived-authority.md) — `v0.1.1` batch H2: panel primary root derived from the host session, the client `primaryRoot` field removed (implemented 2026-09-15, unreleased).
- [2026-09-15-dsh-compat-contract.md](./completed/2026-09-15-dsh-compat-contract.md) — `v0.1.1` batch H3 + H4 Phase 1: DSH compatibility becomes a code contract enforced at startup, bringing `0.1.6-alpha.1` and top-level additional-root instruction injection in with it (implemented 2026-09-15, unreleased).

### Batch Numbering

- **M1–M4** are the MVP roadmap milestones (M4 = the cross-process lease).
- **H1–H4** are the `v0.1.1` hardening batch: H1 = M4, H2 = panel authority, H3 = the compatibility contract, H4 = additional-root instructions (Phase 1 top-level and Phase 2 nested are both done).
- Single source of truth: the [roadmap progress ledger](./active/2026-09-12-multi-root-workspace.md#进度总账).

## Naming Convention

Use lowercase kebab-case, for example:

```text
YYYY-MM-DD-<short-title>.md
```

See the `.agent/templates/plan.md` template.
