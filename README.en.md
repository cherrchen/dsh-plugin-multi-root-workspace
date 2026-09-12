# dsh-plugin-multi-root-workspace

## What & Why

An out-of-tree plugin bundle for DSH (DeepSeek Harness) that widens the Workspace write scope from a single canonical directory to "**one primary root + N additional roots**" — **without modifying any package in the upstream repository**.

The problem it solves: a real development project is usually several independent Git repositories, while DSH natively treats only the session working directory as the writable root, so working across repositories means juggling sessions.

Three things make this plugin worth looking at:

- **Zero learning cost for the agent**: it keeps using the native `read` / `write` / `edit` / `bash` tools. The plugin adds no `workspace_*` tools at all; it only widens the answer to the one question "which directories belong to this workspace".
- **Security does not degrade**: the additional roots are granted through the same mechanisms the harness already uses — the in-process fs fence plus kernel-level runners (Seatbelt on macOS, bwrap / Landlock on Linux) — with the fs side and bash/PTY sharing one and the same scope. It never degenerates into danger-full-access or prompt-level constraints.
- **Absent when absent**: it replaces the upstream `fs-sandbox` and `sandbox` provider rows through a bundle patch; with no additional root configured its behavior is item-for-item identical to an uninstalled harness, and every misconfiguration fails loudly instead of silently degrading.

The first release (MVP) is complete and accepted: M1 composition and empty-root pass-through, M2 multi-root capability and dialect grants, M3 root registry / the `/workspace-folders` command / the Workspace Folders panel / a cross-repository journey e2e. Evidence lives in the [completed plans](./docs/plans/README.md).

## Quick Start

With a DSH runtime at hand (web / Electron desktop / headless all work), the shortest path is three commands:

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
dsh plugin --profile web add ./dsh-plugin-multi-root-workspace
dsh --profile web
```

Once it is up, the **Folders** action (`🗂`) appears at the sidebar foot — or, straight in a session:

```text
/workspace-folders add ~/code/another-repo
```

The agent can now read, write, and run bash in that directory, with the same rights as this session's workspace.

## Requirements

- **Node.js** `^22.19.0 || >=24` (pinned by the repository's `engines`) and **Git**
- **pnpm 11** (`packageManager` pins `pnpm@11.25.0`; corepack recommended)
- **DSH runtime `0.1.5-rc.2`** (exact dev pin; the upgrade procedure lives in the [development workflow](./docs/development/plugin-development-workflow.md))
- **Platforms**: kernel-level multi-root is complete on macOS (Seatbelt) and Linux (bwrap or Landlock); on Windows only the `fs` write path covers additional roots (confined bash/PTY does not — see [known limitations](#known-limitations-first-release))
- Running the smoke tests needs **no model credentials**: the e2e model turns are served by an inline scripted OpenAI-compatible endpoint

## Installation

Prepare a development environment from source:

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true    # without a TTY, pnpm's dependency self-check aborts; see the development workflow §8
pnpm install
pnpm build        # produces lib/ (not tracked by Git); the artifact test and installation both need it
```

## Running

Development gates, with the result each step should produce:

```sh
pnpm lint && pnpm typecheck   # expect: 0 warnings, 0 errors; both tsconfigs pass
pnpm test                     # expect: all pass; dialect cases without a local kernel runner skip explicitly, with a reason
pnpm kernel:probe             # expect: reports the kernel runners this host has (seatbelt / bwrap / landlock)
pnpm smoke                    # expect: compose 34/34, behavior 99/99, journey 28/28
pnpm docs:check               # expect: 0 errors, 0 warnings
```

Install into a DSH runtime and verify the composition:

```sh
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config
```

Expected: **only** the `fs-sandbox` and `sandbox` rows are replaced by the plugin's `multi-root-fs` / `multi-root-sandbox`, with three rows inserted (scope / registry / command); `bash-sandbox` stays upstream (bash and the PTY backend take their roots from `ctx.sandbox`). After starting `dsh --profile web`, the Folders action appears at the sidebar foot.

## Usage

**The command** (the text entry point; also available headless):

```text
/workspace-folders                       # list the primary root and the additional roots
/workspace-folders add <absolute path>   # with no path, opens the OS directory chooser
/workspace-folders alias 1 payments      # name the first additional root
/workspace-folders remove 1              # by ordinal or by path
/workspace-folders reveal 1              # show it in the file manager
```

After an `add`, `list` prints:

```text
Workspace root (primary, always writable): /home/me/monorepo
  1 /home/me/payments-service [payments]
  2 /home/me/website
Writable additional roots: 2 of 2.
```

**The panel** (Web GUI): the **Folders** dialog at the sidebar foot lists the primary root and the additional roots, and offers add (through the composed directory picker or a typed path), remove, alias, copy path, reveal in the file manager, and move up/down. Its copy is bilingual and follows the interface language. A root's state is shown honestly: `missing` (absent right now) and `redirected` (replaced by a symlink pointing elsewhere) keep their registration but are **not granted**; once the directory is back, a `list` or a panel refresh grants it again — no restart.

**The model side**: the additional-root topology reaches the model through a `systemPrompt.context` snapshot attached to every request (same workspace, cwd unchanged) — no introspection tool needed. The full authorization semantics (canonicalization, `recordedPath` against symlink transplants, conflict rejection) live in the [architecture document](./docs/architecture/multi-root-workspace.md).

## Project Structure

```text
src/
  roots.ts        pure rules: canonicalization, conflict validation, record classification (available/missing/redirected/invalid)
  registry.ts     the root registry: dsh-storage-domain persistence, mutations of one primary root serialized in one queue
  scope.ts        ctx.multiRootScope: the single authorization source, plus the model-visible topology snapshot
  fs.ts           the multi-root filesystem provider (in-process fence, extends the upstream LocalFileSystem)
  sandbox.ts      the multi-root kernel-sandbox provider (extends the upstream LocalSandboxProvider)
  dialects.ts     Seatbelt / bwrap / Landlock profile recognition and additional-grant assembly (unrecognized shapes fail loudly)
  containment.ts  path containment (lexical fast path plus a dev/ino alias fallback)
  command.ts      the /workspace-folders command and the host half of the panel RPC
  contract.ts     the panel wire protocol (zod-validated on both ends, inlinable into the browser bundle)
  client/         the browser half: sidebar action, dialog, bilingual dictionaries
tests/            differential parity, real-execution dialect matrix, contract round-trips, component and locale gates
scripts/          smoke batteries (compose / behavior / journey) plus the docs and kernel-runner checks
docs/             requirements, architecture, decision records (ADRs), plans, development workflow
```

## Contributing

Issues and PRs are welcome:

1. Read [`AGENTS.md`](./AGENTS.md) (repository-wide rules) and the [development workflow](./docs/development/plugin-development-workflow.md) (environment, commands, the two-runtime matrix, the upgrade procedure) first.
2. Branch from `main`; follow conventional commits (`feat` / `fix` / `perf` / `refactor` + scope) — see the existing history.
3. All of these must pass locally before a PR: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (CI runs the same order, build before test).
4. Behavior changes update the matching document under `docs/` in the same change; keep the README bilingual pair in sync; record engineering decisions that involve trade-offs as ADRs.
5. Hard constraint: **never modify any package of the upstream repository (deepseek-harness)**; the plugin stays an out-of-tree extension.

## Known Limitations (first release)

- Kernel-level multi-root does not exist on Windows: the `fs` write path covers additional roots, but confined bash/PTY cannot write them (the plugin emits one explicit warning for a populated scope); see the first-release scope in the [requirements document](./docs/requirements/multi-root-workspace.md).
- An additional root has the same rights as the primary root (no per-root read-only), and cannot become the default working directory of bash/PTY (session cwd semantics are unchanged).
- The `workspace-files` client file tree still sees the primary root only.
- The command's own output text is English (a host-side handler has no active locale to consult); the panel is bilingual.
- The Workspace Folders panel is a sidebar footer action plus a dialog rather than a full panel: the `sidebar.panellist` / `main` slots exist only in 0.1.5, while the installed 0.1.2 desktop runtime has neither, and one implementation keeps both runtimes supported.

## Documentation

Long-term project documentation lives in [`docs/`](./docs/README.md):

- [Requirements](./docs/requirements/multi-root-workspace.md)
- [Target architecture](./docs/architecture/multi-root-workspace.md)
- [Upstream research](./docs/reference/multi-root-workspace-research.md)
- [Decision records (ADRs)](./docs/decisions/README.md)
- [Plans](./docs/plans/README.md)
- [Development workflow](./docs/development/plugin-development-workflow.md)
- [Troubleshooting](./docs/troubleshooting/README.md)

Repository-wide rules for Coding Agents are defined in [`AGENTS.md`](./AGENTS.md).

Chinese documentation: [`README.md`](./README.md)

## License

[MIT](./LICENSE)
