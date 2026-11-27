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

The architecture documents distinguish **implemented Current state** from **future Target / Proposed designs**, with the boundary marked in each document header and section:

- [multi-root-workspace.md](./multi-root-workspace.md) — upstream-unmodified design for Multi-root Workspace: provider replacement + subclassing.
  - Implemented (M1/M2/M3/M4): composition, scope resolution, both providers, the topology snapshot, the root registry / command / panel (primary root derived from the session cwd, ADR-0008), and the cross-process Authority Lease.
  - Still Target: the long-term upstream seam (§8) and the appendix (§9).
- [registry-authority-service.md](./registry-authority-service.md) — Shared Registry authority: ordered admissions, kernel-authenticated IPC, consumer seams, fail-closed recovery and takeover (implemented; platform evidence in the progress ledger).
- [file-browsing-providers.md](./file-browsing-providers.md) — Files-tab local/SSH-remote browsing providers: component dependencies, the selection/identity/authority/transport layers, the capability matrix, the metadata lease (not file watching) and the bounded security posture (implemented P1–P5; the remote preview extension remains Target).
- [remote-file-preview.md](./remote-file-preview.md) — Remote file preview: plugin-owned viewer, `filePreview:'stable-path'` authorization, opaque resource identity, bounded SFTP reads over binary RPC, and lease and rendering boundaries.

## Naming Convention

Use lowercase kebab-case, for example:

```text
<subsystem-or-topic>.md
```
