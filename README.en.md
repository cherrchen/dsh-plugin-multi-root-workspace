<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

[中文](./README.md) | English

</div>

## What & Why

By default, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) treats the directory a new workspace is created in as the agent's primary directory; under the default workspace read-write mode (`workspace-write`), the sandbox's read-write scope covers that directory alone. This plugin extends DSH's workspace scope to "one primary root + N additional roots".

Not every project is a monorepo. A real development project is usually several independent Git repositories, and working across them meant juggling sessions. Peer harnesses already support adding multiple folders to a single workspace. This plugin brings the same capability to DSH — register the other repositories as additional roots, grant each read-only, read-write, or unrestricted access, and the agent can work in them within that grant.

- **No new tools**: the agent keeps using the native `read` / `write` / `edit` / `bash`; only the granted directories grow.
- **Sandbox confinement**: an additional root may inherit the session's (primary root's) permission setting, or be pinned to read-only or read-write; under read-only and read-write, confinement does not rest on system prompts — it is enforced by an in-process filesystem fence plus kernel-level sandboxes (macOS Seatbelt / Linux bwrap / Landlock / Windows ACL), with native filesystem and bash calls passing through these fences sharing the same scope. Third-party tools that launch their own Workers need separate validation; see the current dsh-ops limitations below.
- **Browse additional roots in the Files tab**: the Files tab header switches between the primary root and any registered additional root; an additional root's directory renders in the same native Files view, with open-file, open-in-app, and auto-refresh behaving identically. The document preview's Folder navigator tree lands on the root containing the previewed file too — locating, expanding, and highlighting exactly as the native navigator does.
- **Optional Auto review (off by default)**: a fork of upstream's experimental auto-review that gives the reviewer the additional directories' context — the current workspace topology, each root's access level, and live instruction files; it ships disabled and only takes effect once the `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review` row is explicitly enabled in the Plugin Manager row list, taking over the official bundle while on.
- **Additional-root Skills**: discovers `.dsh/skills` and `.agents/skills` inside additional folders, invoked through the namespaced `/alias-id:skill-name` reference and the native `skill` tool; each root has an independent toggle and editable `aliasId`, with a global setting that defaults to on.
- **Worktree root suggestions (experimental, off by default)**: when the primary root is a Git main checkout or a linked checkout, the plugin discovers other worktrees sharing the same common Git directory and, after the user confirms, registers their source trees as `inherit` additional roots. Discovery reads only Git metadata the plugin parses itself — no Git subprocess, no automatic add or remove. A linked worktree can also explicitly authorize the main checkout root, closing the shared-metadata write gap for confined `git add` / `git commit` ([ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md), Chinese).
- **Absent when absent**: with no additional root configured, its behavior is item-for-item identical to an uninstalled harness; every misconfiguration fails loudly instead of silently degrading.

Current released version: `v0.1.18`. The user-visible changes of each version live in the [CHANGELOG](./CHANGELOG.en.md); progress and release state live in the [roadmap progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Quick Start

The plugin is published on [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). Open the **Plugins** page in the sidebar, choose **Add plugin**, and paste the package name `@dsh-electron/dsh-plugin-multi-root-workspace` — or install it in two commands:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # pick the --profile for how you launch DSH; see its docs for the values
```

Once it is up, the **Folders** action (`🗂`) appears at the sidebar foot; on DSH `0.2.1-alpha.3` and newer, the same entry also appears at the right edge of the New Session hero row (same height and type scale as the adjacent workspace and mode selectors, no dropdown chevron, icon-only in narrow windows) — or, straight in a session:

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

The agent can now read, write, and run bash in that directory — the default is `inherit`, so the access level follows the session mode. Other install options (tarball, GitHub, a local clone) are covered under [Installation](#installation).

## Requirements

**Using the plugin**: a DSH runtime at exactly one of the versions below — an exact match, not a range. `dsh plugin` handles the install; no local Node toolchain is needed.

| DSH line | Supported releases |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3` |

The plugin does not start — as if it were not installed — when the DSH release is not in the table or the `@deepseek-ai/dsh-*` packages disagree on a version.

**Building from source / contributing**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (enable via corepack); the dev-pinned DSH is `0.2.2-rc.3` (Node ≥24.9).

**Platforms**: macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set ACL runner).

## Installation

The same install is available without the CLI: open **Plugins** in the sidebar, choose **Add plugin**, and enter the npm package name (or a Git address, tarball, or absolute local path).

`dsh plugin` supports four install sources. All commands below use the web profile as the example; for the Electron desktop swap `--profile web` for `--profile desktop` — the install method is the same.

| Source | Command | Notes |
| --- | --- | --- |
| npm registry (recommended) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Pre-built artifacts, ready to use |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Builds automatically from source on install; `allowBuilds` must name this package too — pin a version |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Pre-built offline package, handy for air-gapped or offline delivery |
| From source | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` to a local checkout — best for development; no `allowBuilds` needed |

**The first `dsh plugin add` fails with `[ERR_PNPM_IGNORED_BUILDS]`**: add the following line to that profile's `pnpm-workspace.yaml`, then run `add` again:

```yaml
allowBuilds:
  koffi: true
```

If the retry `exits 0` but the plugin never lands in `dsh.profile.bundles`, do a `remove` + `add`. Further diagnosis: [troubleshooting](./docs/troubleshooting/install-stops-at-build-approval.md).

### Install from npm (recommended)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

This installs pre-built artifacts; the first install needs the `allowBuilds` addition described above.

### Install from a tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# or download the tgz from the GitHub Release assets, e.g.:
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.18/dsh-electron-dsh-plugin-multi-root-workspace-0.1.18.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.18.tgz
```

Also pre-built, handy for air-gapped or offline delivery; the first install needs the same `allowBuilds` addition.

### Install from GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

A GitHub install fetches source code and builds it automatically during `add` — no manual build needed — but `allowBuilds` has to cover two entries, this package itself and `koffi`:

```yaml
allowBuilds:
  '@dsh-electron/dsh-plugin-multi-root-workspace': true
  koffi: true
```

Pinning a version (e.g. `#v0.1.18`) is recommended so a later push cannot silently change what actually runs:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.18
```

### Install from a local clone

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> If `dsh` is not on your PATH (e.g. you run DSH from a source checkout), use `pnpm dsh` instead.

## Running

Development gates:

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

Install into a DSH runtime and verify the composition:

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

Expected output:

```text
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true
--
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
--
# == @dsh-electron/dsh-plugin-multi-root-workspace
- id: multi-root-compat
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/compat'
- id: multi-root-fs
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
- id: multi-root-sandbox
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
- id: multi-root-providers
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/providers'
- id: multi-root-scope
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  config:
    toolAccess: {}
- id: multi-root-registry
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
- id: multi-root-instructions
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/instructions'
  config:
    maxBytes: 65536
- id: multi-root-lsp
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/lsp'
- id: multi-root-workspace-files
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/workspace-files'
- id: multi-root-command
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
- id: multi-root-client
  name: '@dsh-electron/dsh-plugin-multi-root-workspace'
```

The upstream `fs-sandbox` and `sandbox` rows are disabled and taken over by the plugin's same-named services, and all the plugin's `multi-root-*` rows are mounted. After startup, a **Folders** action appears at the sidebar foot; DSH `0.2.1-alpha.3` and newer also show the same entry at the right edge of the New Session hero row.

## Usage

### Command

```text
/workspace-folders [list]                                                    # list the primary root and the additional roots (access and state included)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write]  # no path opens the OS directory picker; new registrations default to inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]               # shortcut for /workspace-folders add
/workspace-folders access <n|path> inherit|read-only|read-write              # switch access (widening requires the root to be available right now)
/workspace-folders skills <n|path> on|off                                    # toggle additional-root Skills independently of write access
/workspace-folders alias-id <n|path> <kebab-case>                             # edit the stable Skill namespace
/workspace-folders alias <n|path> [name]                                     # omitting the name clears the alias
/workspace-folders remove <n|path>                                           # n is the number list prints
/workspace-folders reveal <n|path>                                           # show it in the file manager
/workspace-folders isolate-profiles [--apply]                                # inspect profile import method and multi-link files under $DSH_HOME; --apply writes copy config
/workspace-folders help                                                      # show the command help
```

Paths may be quoted; a path that duplicates an existing root, nests inside one, or is the workspace root itself is rejected.

Access is three-state ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md); the [usage guide](./docs/guide/README.en.md#access-levels-the-root-limit-and-per-tool-caps) has the exact semantics): `inherit` follows the session mode — writable under `workspace-write`, refused under `read-only`, unrestricted under `danger-full-access`; `read-only` refuses writes in every mode, including Full-access; a fixed `read-write` root stays writable even in a read-only session. The single exception: a user-approved one-shot `danger-full-access` escalation lifts the read-only-root and per-tool-cap refusals for that call alone (`$DSH_HOME` and the unavailable-authority downgrade excepted — [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)). Writable records registered by older plugin versions read back as `inherit`. A primary root accepts at most 16 additional roots (`maxAdditionalRoots` can raise it to 64). A host may also cap a tool for all additional roots via `toolAccess` on the `multi-root-scope` row — e.g. `{ bash: 'read-only' }` keeps bash from ever writing an additional root (it can still write the primary root; the same approved one-shot escalation lifts the cap for that call).

After an `add`, `list` prints (a `workspace-write` session, with `website` registered read-only):

```text
Workspace root (primary; access follows the current sandbox mode): /home/me/monorepo
  1 /home/me/payments-service [payments] (inherit)
  2 /home/me/website (read-only)
2 of 16 additional roots.
Writable additional roots under the current mode: 1 of 2.
```

### Additional-root Skills

Skills are discovered in each additional folder’s `.dsh/skills` and `.agents/skills`. Names and descriptions are available before the first model step; bodies are loaded on invocation. The primary root uses `/skill-name`; additional roots always use `/alias-id:skill-name`, with Slash completion and manual entry. The model uses the native `skill` tool with an internal name. Internal IDs can appear in tool logs; human menus list namespaced references.

New `inherit` and `read-write` registrations enable Skills by default; `read-only` registrations disable them. The Workspace Folders dialog provides an independent Skills toggle and editable `aliasId`. Renaming the display Alias keeps `aliasId` stable. An actual change to registered access resets the toggle; session sandbox mode changes, same-value access updates, and re-registration without an access change preserve the manual choice. Enabling Skills on a read-only root grants no write access.

**Enable additional-root Skills** under Settings → Plugins → Multi-root Workspace controls all additional roots and defaults to on. Disabling it stops new discovery and invocation while preserving each root’s choice. Re-enabling restores discovery according to those choices. Primary-root Skills, instructions, LSP, browsing, and sandbox permissions retain their behavior. Older hosts use the compatible plugin settings page. Namespaced references appear as ordinary user text, without a separate background, highlighting, or click-to-preview action. Native draft highlighting does not yet support colon references.

On upgrade, legacy `inherit` and `read-write` registrations start with Skills enabled. Migration preserves existing grants. An older plugin can strip `aliasId` and manual toggles when it writes the registry; upgrading again applies the defaults. **Lossless downgrade of Skills preferences is not guaranteed.** Back up `$DSH_HOME/storages/multi_root_workspace.json` before downgrading if preferences must survive. Disabling Skills does not remove previously delivered bodies from history or stop processes already started.

See [ADR-0023](./docs/decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md) for the architecture and acceptance boundaries, and the [progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#multi-root-skills-架构验证2026-10-23) for implementation and platform evidence.

### Worktree root suggestions

When the primary root is itself the root of a Git main or linked checkout, the plugin discovers the other worktrees that share this repository's common git dir — including worktrees that existed before the session, or were created by a terminal, an IDE, a forge, or another DSH instance — and, after confirmation, registers that worktree's source tree as an `inherit` additional root. Discovery only reads Git metadata the plugin opens and parses itself (the `.git` pointer, the admin dir, the common config/HEAD/index, and the full ancestor chain). It **starts no Git subprocess, resolves no commit object, and never adds or removes a root on its own.** The feature is **experimental and off by default**; turn it on explicitly in the plugin detail card.

There is no special rule for the default pool: with the main repository as primary, `.agents/worktrees/<id>` lies inside the primary and is filtered by the ordinary containment rule; with a pool worktree as primary, its sibling worktrees remain candidates (still subject to registration, the root limit, and "do not suggest again"). Submodules (including a linked worktree that is itself a submodule), bare-derived linked worktrees, a `--separate-git-dir` main checkout, `extensions.worktreeConfig`, `core.repositoryformatversion=1` / `--relative-paths`, and split/sparse indexes are never suggested.

Prompts are workspace-shared and filtered by the session's sandbox mode: read-write sessions may confirm read-write, read-only sessions see read-only while the registration policy stays `inherit`, and Full-access gets no prompt. **Exactly one visible candidate uses the original confirmation dialog; two or more use a checkbox list** (worktrees are pre-selected, the main checkout stays an explicit opt-in with its disclosure), and several folders can be confirmed at once. A registration is workspace-wide, so **other read-write sessions also gain write access to that folder**; the dialog says so explicitly. After confirmation the Registry owner re-runs the complete primary/candidate judgment (HEAD syntax and directory identities included) inside its existing serialized queue. Any change while the prompt is open invalidates that row (`worktree/prompt-stale`); the other rows continue, and the refused row stays unregistered.

When a worktree disappears or moves, the Workspace Folders panel shows a badge; **nothing is ever cleaned up automatically.** Only when the registered path is confirmed missing (`ENOENT`/`ENOTDIR`) and `rootId + path + addedAt` still match does the panel offer per-row or batch cleanup. An existing or inaccessible path — or a checkout whose old admin vanished but which is still valid — only offers the ordinary Remove. A missing root keeps consuming `maxAdditionalRoots` until it is cleaned up or removed manually, and until then a new directory at the same path can inherit the old grant; the panel shows that warning.

**Enable worktree root suggestions**, on the same Settings → Plugins → Multi-root Workspace card, carries an **Experimental** tag and **defaults to off**; it is independent of "Enable additional-root Skills". Only an explicit opt-in starts discovery, prompts, and the dedicated cleanup UI. Turning it off leaves already registered roots under ordinary root management. See [ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md) for the decision and acceptance boundaries.

### Main checkout authorization (A)

When the session workspace is itself a linked worktree and the session is `workspace-write`, the plugin offers to register the repository's **main checkout root `<main>` (the parent of the shared common, usually the main checkout's source root)** as an `inherit` additional root. The dialog shows the actual path and the scope: the main checkout's source tree, shared config, hooks, refs/objects, and every worktree's admin data, which may affect other checkouts of the same repository; the registration is still workspace-wide.

A only appears when the primary's complete snapshot proves the common's identity and `<main>/.git` is still a real directory that is that common. It closes the write gap for `git add` / `git commit` in a confined `workspace-write` session and **also authorizes the main checkout's source tree**. A default-pool primary lives inside `<main>`, so `primary-overlap` refuses it and the pool gets no A; with `--separate-git-dir`, the derived path can be the store's parent rather than the real main checkout, so the dialog shows the actual path and asks the operator to check it. While the prompt is open, a changed primary/admin/common file-system identity, back-pointer, admin HEAD, ancestor index, main-root identity, or a replaced `<main>/.git` invalidates it and nothing is written.

`read-only` and `danger-full-access` never prompt A; a mode change or turning the switch off invalidates an open prompt. A roots never enter the worktree cleanup mapping and deleting the linked checkout does not clean them up; use the ordinary Remove to revoke one. The real restricted-shell Git journey runs according to the kernel capability probe and skips explicitly with a reason on a host whose outer sandbox refuses nesting.

### Panel

The **Folders** entry at the sidebar foot — and, on DSH `0.2.1-alpha.3` and newer, the same entry at the right edge of the New Session hero row — opens the same dialog, which lists the primary root and the additional roots and offers add, remove, alias, read-only/read-write switching, copy path, and reveal in the file manager. The hero entry shares the adjacent workspace and mode selectors' geometry and interaction, but it opens a dialog rather than a menu and therefore deliberately has **no chevron**; at `≤560px` it becomes an icon-only 28×28 button whose name stays on `aria-label` / the tooltip. The hero row disappears after the first message, leaving the sidebar entry in place; older runtimes only ever show the sidebar entry.

### Model side

The additional-root topology is injected into the system prompt so the model knows which directories are available, and the information updates when grants change. No new tool needs to be exposed to the model.

## Optional Auto Review integration

For multi-root reviewer context, enable the default-disabled [Auto Review row](./src/auto-review/README.en.md) in the main package’s Plugin Manager row list; the experimental "Multi-root Auto Review" switch in the same detail page's settings card is equivalent to that row switch and is off by default as well. The joint integration targets only DSH `0.2.1-rc.2`; ordinary installation keeps the existing support matrix and does not enable or select Auto.

## Project Structure

```text
.
├── src/
│   ├── roots.ts                      pure rules: canonicalization, conflict validation, record classification (available/missing/redirected/invalid)
│   ├── registry.ts                   one storage core and Host facades, store-wide ordering of mutations and admissions
│   ├── registry-lease.ts             cross-process Registry Authority: POSIX flock (the kernel releases it on process death)
│   ├── registry-lease-win32.ts       ditto, the Windows named-semaphore implementation
│   ├── scope.ts                      ctx.multiRootScope: the single authorization source, plus the model-visible topology snapshot
│   ├── fs.ts                         the multi-root filesystem provider (in-process fence, extends the upstream LocalFileSystem)
│   ├── sandbox.ts                    the multi-root kernel-sandbox provider (extends the upstream LocalSandboxProvider)
│   ├── dialects.ts                   Seatbelt / bwrap / Landlock profile recognition and additional-grant assembly (unrecognized shapes fail loudly)
│   ├── windows-*.ts                  the Windows root-set ACL runner and restricted-token execution
│   ├── containment.ts                path containment (lexical fast path plus a dev/ino alias fallback)
│   ├── instructions.ts               discovery, incremental delivery, budget and revocation for an additional root's AGENTS.md / CLAUDE.md (top level plus the subdirectories this session touched, injected from agent/pre-step)
│   ├── lsp.ts                        a separate LSP workspace initialized per additional root
│   ├── workspace-files.ts            host-side routing and confinement for additional-root file browsing in the Files tab
│   ├── compat.ts                     the multi-root-compat startup gate (version allowlist and mixed-install detection)
│   ├── compat/                       the version-difference adapters: dsh-version / sandbox-confine / agent-instructions / llm-message, etc. (optional peers loaded on demand)
│   ├── command.ts                    the /workspace-folders command and the host half of the panel RPC
│   ├── worktrees.ts                 the worktree suggestion row: discovery/activation/watchers, the prompt queue and waiters, confirmation and explicit cleanup
│   ├── worktrees/                   controlled Git metadata snapshots (config/HEAD/index/ancestor chain), inventory, the sidecar and owner re-verification (no Git subprocess)
│   ├── worktrees-contract.ts         the worktree endpoints' strict two-sided contract (discriminated union, no retry field)
│   ├── contract.ts                   the panel wire protocol (zod-validated on both ends, inlinable into the browser bundle)
│   └── client/                       the browser half: sidebar action, the Folders dialog, the Files-tab root switcher, bilingual dictionaries
├── tests/                            differential parity, real-execution dialect matrix, contract round-trips, component and locale gates, cross-process lease e2e, instruction injection
├── scripts/                          smoke batteries (compose / behavior / journey) plus the docs, kernel-runner, compatibility-contract and upgrade checks
└── docs/                             requirements, architecture, decision records (ADRs), plans, development workflow
```

## Contributing

Issues and PRs are welcome:

1. Read [`AGENTS.md`](./AGENTS.md) (repository-wide rules) and the [development workflow](./docs/development/plugin-development-workflow.md) (environment, commands, the runtime support matrix, the upgrade procedure) first.
2. Branch from `main`; follow conventional commits (`feat` / `fix` / `perf` / `refactor` + scope) — see the existing history.
3. All of these must pass locally before a PR: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (CI runs the same order, build before test).
4. Behavior changes update the matching document under `docs/` in the same change; keep the README bilingual pair in sync; record engineering decisions that involve trade-offs as ADRs.
5. Hard constraint: **never modify any package of the upstream repository (deepseek-harness)**; the plugin stays an out-of-tree extension.

## Known Limitations

- **dsh-ops bypassed an explicit read-only root restriction (F01, historical baseline)**: in the audited versions under Full access, the Native `ops_write_file` tool actually changed a file in an additional root pinned read-only, while the native filesystem control was denied. With OPS compatibility mode enabled, this round's limited adaptation makes the explicit RO/cap deny boundary effective for OPS Native and real PTC under Full access (deny-execution re-verification in [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); see the [compatibility audit](./docs/reviews/dsh-ops-compatibility-audit.md) (Chinese) for versions, scope, and original evidence.
- **Legal additional-root writes and nested instructions had gaps with dsh-ops (F04/F05, historical baseline)**: OPS preflight still rejects inherited or pinned read-write additional roots under workspace-write and pinned read-write roots under read-only (F04 unresolved). The nested-instruction gap (F05) is re-verified as recovered with the mode enabled this round: with the live index, real AgentLoop evidence shows successful Native and PTC touches delivering the subdirectory chain into the next model request (see [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)). The tested root-level instructions and Skills paths still work.
- **Linux bwrap workspace-write batch/result is degraded (F07)**: with the audited shared Registry composition, every `ops_batch` / `ops_result` call (including `page`) that reaches the launch branch with a valid cache loses its argv ownership proof when OPS adds a bind after confinement. The source path rejects the Worker launch with `EXECUTOR_UNAVAILABLE`. The function-level conflict is reproduced; Linux end-to-end execution is untested. Ordinary read-only, Landlock, and no-cache controls are outside this conclusion. An OPS interface to declare cache requirements before confinement is needed; no MR-only workaround has been validated. See [F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Other OPS availability limits**: under shared workspace-write, purge outside dispatch is rejected without a live admission, so result caches may remain with a warning. Nested PTC calls and background Bash also risk rejection from mismatched or expired proofs. The conservative refusal boundaries have been validated on all three platforms. Normal background execution and cleanup remain unavailable and are deferred indefinitely; see the [final scope in ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05) (Chinese).
- An additional root's instruction files arrive as they become relevant: the one at the root's top level is injected before the session's first step, and a subdirectory's is injected once the session has **successfully** worked in that directory. A nested file is re-examined only when its directory is examined (the root's own every step; a subdirectory's because it was delivered from, or because of a fresh touch), delivery state is in-process (so a resumed session may be told again); officially the `read` / `write` / `edit` tool names count, and OPS tools also drive delivery through live evidence when OPS compatibility mode is enabled (OPS history without live evidence does not count after a resume). The primary root's chain and the user-global file remain upstream's job, and this plugin does not inject them a second time ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Hosts share one Registry service: one Host owns storage and each instance obtains admission for new operations. Disconnection stops new additional-root grants; a successor takes over through the kernel lease. Sharing is local to one user and lock namespace; Linux requires SO_PEERPIDFD, and Windows is limited to one login session. Existing processes and PTYs retain their launch snapshot ([architecture](./docs/architecture/registry-authority-service.md), Chinese).
- The supported matrix is an exact-version allowlist: on a host whose release is not on the list, or whose core packages disagree about the release, the `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` rows **do not start** and the composition degrades to "the plugin is not installed" ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- The Windows multi-root runner inherits upstream partial enforcement, caller-owned directory requirements, and private-temp isolation. Running processes retain their initial roots; later processes use the updated set ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Network and device paths cannot be additional roots on Windows**: UNC (`\\server\share`), `\\?\`, `\\.\`, and mapped network drives are rejected at registration with `unsupported-path` — the restricted token's capability SID cannot be shown to bind SMB access ([ADR-0011 amendment](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **The confined Windows shell is pwsh; Git Bash is not available**: MSYS cannot start under the write-restricted Low-integrity token (identically under the upstream and plugin runners — an upstream limitation). An upstream-confined child also cannot receive Ctrl+C (it inherits the runner's ignore flag); under the plugin runner Ctrl+C reaches the child and the runner mirrors its exit code.
- Additional-root access is three-state: new registrations default to `inherit` (they follow the session mode), `--read-only` refuses writes in every mode (including Full-access; the only exception is a user-approved one-shot escalation on a single call — [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), and a fixed `--read-write` stays writable even in a read-only session — it is a question of write authority, never read confinement ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). A running process or persistent terminal keeps the deny set it was started with — a terminal started before a root turned read-only stays unrestricted until restarted; cap and access changes constrain only later calls and new processes ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); hosts with workingDirectory may use an additional root as the execution directory for later tools, while the session origin and registry identity stay unchanged ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **On Linux hosts where upstream selected Landlock, a restricted Full-access needs bubblewrap**: Landlock's allowlist cannot express "everything writable except these roots", so that combination selects bwrap to spell the deny boundary; on a host without a usable bwrap (not installed, or unprivileged user namespaces disabled), a Full-access command that carries any deny boundary (a read-only root, or the protected `$DSH_HOME`) fails closed at launch. Enable bwrap there, or avoid explicit read-only roots under Full-access on such hosts ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- Browse additional roots from the **Files tab's root switcher**: the header entry lists the primary root and every additional root, with the selected root's full path still shown beside it; selecting one lets a byte-for-byte fork of the upstream Files tree take over the tree area (lazy-loaded directories, native rows and icons, watch-driven auto-refresh, file clicks opening in the host viewer, plus a manual refresh in the header's reload spot), and the header's open-in-app button is simultaneously replaced by a byte-for-byte fork of the upstream control that opens the selected root instead of the primary one; switching back to the primary root restores the native view. The dialog is management-only again. The takeover relies on upstream `data-*` DOM hooks and degrades silently to the native look when they stop matching ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). LSP uses the containing additional root as its own workspace; the host must configure the relevant language server ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- The command's own output text is English (a host-side handler has no active locale to consult); the panel is bilingual.
- The Workspace Folders panel is a sidebar footer action plus a dialog rather than a full panel: `sidebar.footer.action` is offered by every supported release, whereas `sidebar.panellist` / `main` are not. Since DSH `0.2.1-alpha.3`, an incremental entry also rides the New Session hero row's `conversation.hero.options` slot: it shares the adjacent workspace and mode selectors' geometry, has no chevron, and degrades to a 28×28 icon button at `≤560px`. Where an older runtime does not declare that slot, the registration silently stays out and the sidebar entry is unaffected ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md), Chinese).

## dsh-ops adaptation status (capability notes)

The implementation is available through **OPS compatibility mode (experimental; limitations may apply)**. Set `multi-root-ops-compatibility.enabled` under `Settings → Plugins → Multi-root Workspace`; it defaults to `false` and requires an explicit opt-in. This feature can only be enabled on DSH `0.2.*` releases within the existing exact support matrix. On `0.1.*`, even a manually configured `enabled: true` stays inactive, and the legacy Settings UI is not supported ([version-scope decision](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06), Chinese). Enabling it from Settings opens the host’s risk dialog: acknowledge the limitations and confirm before the setting is saved. Cancel, close, or press Esc to keep it disabled.

- **Enabled**: activates OPS execution protection, live activity, and Review enhancements. Full-access (`danger-full-access`) enforces explicit RO/cap deny boundaries through kernel confinement on the verified macOS and Linux lanes. On Windows, deny-bearing OPS execution calls, including reads, are conservatively refused before Worker preparation; protected preparation and legal writes in that combination are not yet supported. In WW/RO, any non-writable additional root or tool write cap causes the entire OPS execution call, including reads/page, to be refused before preparation and execution. All modes refuse OPS execution when Registry authority is unavailable; pure discovery/publication remains available. Subprocess launches also require a protected execution domain or a profile from the current admission, preventing background cleanup from bypassing boundaries. This can also reject third-party background processes; the panel’s user terminal is unaffected.
- **Disabled**: restores OPS behavior from before this adaptation, without these safeguards — **OPS may write to an explicitly read-only additional root**. Normal multi-root features, native tool fences, and Auto Review's own toggle are unaffected. Delivered instructions are not retroactively erased; calls already inside a protected execution domain and running processes retain their original snapshot. Newly started calls no longer activate this adaptation.
- **Experimental limitations**: only the Phase-A live activity index is available; there is no durable event bridge. While enabled, OPS history without live evidence after resume and dynamic pending actions (replace/batch/result/bash/unknown) cause Review to fail technically. Non-allowlisted diagnostics such as `ops_status` are also subject to this conservative rule.

The MR-only P5 safeguards require no OPS changes. Legal additional-root writes can still be rejected, and result caches may remain when cleanup is refused. In legacy mode without a shared Registry, WW/RO PTC can also be refused before its code process starts. Durable activity stays disabled: DSH explicitly prohibits external plugins from calling `appendPluginRecord`; ordinary events and direct log writes are not substitutes. P6 technical acceptance is complete for this bounded scope. Remaining P5 capabilities and full OPS compatibility acceptance are **deferred indefinitely** and excluded from this acceptance; any future recovery will remain experimental. The canonical deferred list is in [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源), with scope recorded in the [completed plan](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md) (Chinese).

These experimental safeguards ship in `v0.1.15`; they do not claim complete OPS compatibility or expand the support matrix. The audit §16 historical re-verification predates this switch and describes the enabled path; reruns require an explicit `enabled: true`.

## Documentation

Long-term project documentation lives in [`docs/`](./docs/README.md):

- [Changelog](./CHANGELOG.en.md)
- [User guide](./docs/guide/README.en.md)
- [Requirements](./docs/requirements/multi-root-workspace.md)
- [Target architecture](./docs/architecture/multi-root-workspace.md)
- [Upstream research](./docs/reference/multi-root-workspace-research.md)
- [Decision records (ADRs)](./docs/decisions/README.md)
- [Plans](./docs/plans/README.md)
- [Development workflow](./docs/development/plugin-development-workflow.md)
- [Troubleshooting](./docs/troubleshooting/README.md)

Repository-wide rules for Coding Agents are defined in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)
