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

A Target Architecture draft exists (not yet implemented; see each document's header for its status):

- [multi-root-workspace.md](./multi-root-workspace.md) — upstream-unmodified design for Multi-root Workspace: provider replacement + subclassing (status: under review).

## Naming Convention

Use lowercase kebab-case, for example:

```text
<subsystem-or-topic>.md
```
