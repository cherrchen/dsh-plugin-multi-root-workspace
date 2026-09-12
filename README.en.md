# dsh-plugin-multi-root-workspace

An out-of-tree plugin bundle for DSH (DeepSeek Harness) that widens the Workspace write scope from a single directory to one primary root plus N additional roots — **without modifying any package in the upstream repository**.

The plugin answers exactly one question: "which directories belong to this workspace". It then opens them through the same mechanisms the harness already uses (the in-process fence and the kernel-runner dialects), so the agent keeps using the native `read` / `write` / `edit` / `bash` tools.

## Project Status

- **M1 (composition and empty-root pass-through) is complete and verified**: the plugin installs through `dsh plugin`, replaces the `fs-sandbox` and `sandbox` provider rows, and with no additional root configured behaves item-for-item like an uninstalled harness. Evidence: the [completed M1 plan](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md).
- **M2 (multi-root capability) and M3 (root management and UI) have not started**: registering additional roots, assembling kernel-dialect grants, and the client UI belong to later milestones.

## Quick Start

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke            # composition gate + empty-root behavior gate
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
