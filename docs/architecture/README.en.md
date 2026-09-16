# Architecture

中文：[README.md](./README.md)

## What Belongs Here

- Current Architecture;
- Target Architecture;
- Subsystem design;
- Component boundaries;
- Data flow;
- Interfaces.

## What Does Not Belong Here

- Requirements (goes to `../requirements/`);
- Decision records (goes to `../decisions/`);
- Implementation plans (goes to `../plans/`).

## Important Rule

Do not present Proposals or Target Architecture as facts about the currently implemented system.

Documents describing future designs must clearly state their status.

## Current State

The architecture document carries **implemented Current state** and **still-future Target pieces**, with the boundary marked in the document header and in each section:

- [multi-root-workspace.md](./multi-root-workspace.md) — upstream-unmodified design for Multi-root Workspace: provider replacement + subclassing.
  - Implemented (M1/M2/M3/M4): composition, scope resolution, both providers, the topology snapshot, the root registry / command / panel (primary root derived from the session cwd, ADR-0008), and the cross-process Authority Lease.
  - Still Target: the long-term upstream seam (§8) and the appendix (§9).

## Naming Convention

Use lowercase kebab-case, for example:

```text
<subsystem-or-topic>.md
```
