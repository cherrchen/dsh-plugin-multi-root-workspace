# dsh-plugin-multi-root-workspace

An out-of-tree plugin bundle for DSH (DeepSeek Harness) that widens the Workspace write scope from a single directory to one primary root plus N additional roots — **without modifying any package in the upstream repository**.

The plugin answers exactly one question: "which directories belong to this workspace". It then opens them through the same mechanisms the harness already uses (the in-process fence and the kernel-runner dialects), so the agent keeps using the native `read` / `write` / `edit` / `bash` tools.

## Project Status

- **M1 (composition and empty-root pass-through) is complete and verified**: the plugin installs through `dsh plugin`, replaces the `fs-sandbox` and `sandbox` provider rows, and with no additional root configured behaves item-for-item like an uninstalled harness. Evidence: the [completed M1 plan](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md).
- **M2 (multi-root capability) is complete and verified**: additional roots reach the in-process fence and the kernel-dialect grants (Seatbelt / bwrap / Landlock) through one and the same scope, pinned by the parity matrix, the dialect unit suite, the topology snapshot, and the multi-root smoke battery. Under `read-only` an additional root is writable no more than anything else, and the empty-root behavior stays byte-identical to an uninstalled harness. Evidence: the [completed M2 plan](./docs/plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md).
- **M3 (root management and UI) has not started**: registry persistence, validation rules, the `/workspace-folders` command, the Workspace Folders panel, and the e2e journey belong to the next milestone. Additional roots are registered today through the plugin's service API (tests and smoke scripts); there is no user interface yet.

## Known Limitations (first release)

- Kernel-level multi-root does not exist on Windows: the `fs` write path covers additional roots, but confined bash/PTY cannot write them (the plugin emits one explicit warning for a populated scope); see the first-release scope in the [requirements document](./docs/requirements/multi-root-workspace.md).
- An additional root has the same rights as the primary root (no per-root read-only), and cannot become the default working directory of bash/PTY (session cwd semantics are unchanged).
- Root existence is not re-checked at session start (that lands with the M3 registry).

## Quick Start

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke            # composition gate + empty-root and multi-root behavior gates
pnpm docs:check
```

Install into a runtime:

```sh
dsh plugin --profile web add <path to this repository>
dsh --profile web --dump-config
```

Commands, the smoke mechanism, the two-runtime matrix, and the upgrade procedure live in [`docs/development/plugin-development-workflow.md`](./docs/development/plugin-development-workflow.md).

## Documentation

Long-term project documentation lives in [`docs/`](./docs/README.md):

- [Requirements](./docs/requirements/multi-root-workspace.md)
- [Target architecture](./docs/architecture/multi-root-workspace.md)
- [Upstream research](./docs/reference/multi-root-workspace-research.md)
- [Decision records](./docs/decisions/README.md)
- [Plans](./docs/plans/README.md)

Repository-wide rules for Coding Agents are defined in [`AGENTS.md`](./AGENTS.md).

Chinese documentation: [`README.md`](./README.md)
