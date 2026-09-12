# dsh-plugin-multi-root-workspace

An out-of-tree plugin bundle for DSH (DeepSeek Harness) that widens the Workspace write scope from a single directory to one primary root plus N additional roots — **without modifying any package in the upstream repository**.

The plugin answers exactly one question: "which directories belong to this workspace". It then opens them through the same mechanisms the harness already uses (the in-process fence and the kernel-runner dialects), so the agent keeps using the native `read` / `write` / `edit` / `bash` tools.

## Project Status

- **M1 (composition and empty-root pass-through) is complete and verified**: the plugin installs through `dsh plugin`, replaces the `fs-sandbox` and `sandbox` provider rows, and with no additional root configured behaves item-for-item like an uninstalled harness. Evidence: the [completed M1 plan](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md).
- **M2 (multi-root capability) is complete and verified**: additional roots reach the in-process fence and the kernel-dialect grants (Seatbelt / bwrap / Landlock) through one and the same scope, pinned by the parity matrix, the dialect unit suite, the topology snapshot, and the multi-root smoke battery. Under `read-only` an additional root is writable no more than anything else, and the empty-root behavior stays byte-identical to an uninstalled harness. Evidence: the [completed M2 plan](./docs/plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md).
- **M3 (root management and UI) is implemented**: the root registry persists under `$DSH_HOME/storages/multi_root_workspace.json`, the `/workspace-folders` command and the sidebar Workspace Folders panel both add and remove roots, and a real session journey across two Git repositories is covered by `pnpm smoke:journey`. Evidence: the [M3 plan](./docs/plans/completed/2026-09-12-m3-root-registry-command-and-ui.md).

## How To Use It

In a session:

```text
/workspace-folders                     # list the primary root and the additional roots
/workspace-folders add <absolute path> # with no path, opens the OS directory chooser
/workspace-folders alias 1 payments    # name the first additional root
/workspace-folders remove 1
```

In the Web GUI: the **Folders** action at the sidebar foot lists the primary root and the additional roots, and offers add (through the composed directory picker), remove, alias, copy path, reveal in the file manager, and reordering. Its copy follows the interface language (English and Chinese).

Rules: a directory is canonicalized before it is stored (`~` expands, symlinks resolve); a candidate that duplicates a root, nests inside or around one, equals the session's own workspace root, is missing, or is not a directory is rejected with a reason. A directory that disappears later keeps its registration but is **not granted** until it comes back — both surfaces say so.

## Known Limitations (first release)

- Kernel-level multi-root does not exist on Windows: the `fs` write path covers additional roots, but confined bash/PTY cannot write them (the plugin emits one explicit warning for a populated scope); see the first-release scope in the [requirements document](./docs/requirements/multi-root-workspace.md).
- An additional root has the same rights as the primary root (no per-root read-only), and cannot become the default working directory of bash/PTY (session cwd semantics are unchanged).
- The `workspace-files` client file tree still sees the primary root only.
- The command's own output text is English (a host-side handler has no active locale to consult); the panel is bilingual.
- The Workspace Folders panel is a sidebar footer action plus a dialog rather than a full panel: the `sidebar.panellist` / `main` slots exist only in 0.1.5, while the installed 0.1.2 desktop runtime has neither, and one implementation keeps both runtimes supported.

## Quick Start

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke            # composition gate + behavior gates + the cross-repository journey
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
