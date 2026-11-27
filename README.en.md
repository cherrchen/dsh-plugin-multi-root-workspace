<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | English | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)

</div>

## What & Why

By default, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) treats the directory a new workspace is created in as the agent's primary directory; under the default workspace read-write mode (`workspace-write`), the sandbox's read-write scope covers that directory alone. This plugin extends DSH's workspace scope to "one primary root + N additional roots".

Not every project is a monorepo. A real development project is usually several independent Git repositories, and working across them meant juggling sessions. Peer harnesses already support adding multiple folders to a single workspace. This plugin brings the same capability to DSH — register the other repositories as additional roots, set each to read-only, read-write, or the session's current permission, and the agent can work in them within that grant.

- **Native tools**: in local workspaces, the agent keeps using the native `read` / `write` / `edit` / `bash`; it just gains a few more directories to work in.
- **Permissions that actually hold**: each additional root can be read-only, read-write, or follow the current session's permissions; the system sandbox enforces this rather than relying on a prompt to keep the model in line. The agent's file operations and bash commands fall under the same grant; processes started by other plugins are outside this guarantee.
- **Browse additional roots in the Files tab**: the Files tab header switches between the primary root and any additional root; the tree, opening files, opening in an external app, context menus, auto-refresh, and search behave the same as in the primary root, and the document preview's navigator also lands on the root containing the file. On older hosts some of these actions may be unavailable, and the additional root keeps the host's native view.
- **Skills in additional roots**: discovers `.dsh/skills` and `.agents/skills` inside additional roots and invokes them as `/alias:skill-name`; each root has its own switch, on by default.
- **Auto Review (experimental, off by default)**: once enabled in the Plugin Manager, automatic review also sees the additional roots' directory structure, access levels, and instruction files, and reviews those roots too.
- **Worktree suggestions (experimental, off by default)**: when the primary root is a Git worktree, the plugin offers to add other worktrees of the same repository as additional roots; nothing is registered until you confirm, and nothing is added or removed automatically.
- **SSH remote environments (experimental, off by default)**: Enable personal SSH on the plugin detail page to use `remote_copy` and `remote_bash` on registered remote directories. Connections and workspace bindings are managed separately, and each call goes through Registry admission. Registered remote directories can also be browsed and previewed read-only in the Files tab (per-binding opt-in, off by default).
- **Absent when absent**: with no additional root registered, behavior is identical to an uninstalled plugin; misconfiguration reports an error instead of silently degrading.

The latest release is the beta prerelease `v0.1.25-beta.2`; npm's `latest` tag still points at the stable `v0.1.24`, so install the beta with an explicit `@beta`. The user-visible changes of each version live in the [CHANGELOG](./CHANGELOG.en.md); progress and release state live in the [roadmap progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Quick Start

The plugin is published on [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). For CLI profiles (`web`, `headless`, ...), install it in two commands:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # pick the --profile for how you launch DSH; see its docs for the values
```

**DSH Desktop users**: enter `@dsh-electron/dsh-plugin-multi-root-workspace` on the Plugins page to install it. If startup reports an error, restart DeepSeek Harness Desktop.

Other install options (tarball, GitHub, a local clone) are covered under [Installation](#installation).

To add an additional root, run this in a session:

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## Requirements

**Using the plugin**: a DSH runtime at exactly one of the versions below — an exact match, not a range. `dsh plugin` handles the install; no local Node toolchain is needed.

| DSH line | Supported releases |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` |
| `0.2.3` | `0.2.3-alpha.2` |

The plugin does not start — as if it were not installed — when the DSH release is not in the table or the `@deepseek-ai/dsh-*` packages disagree on a version.

**Building from source / contributing**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (enable via corepack); the dev-pinned DSH is `0.2.3-alpha.2` (Node ≥24.22.3).

**Platforms**: macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set ACL runner).

## Installation

Install the plugin either from the command line (CLI) or from the GUI plugin manager in Web / Desktop. Either one is enough.

### Install from the CLI

`dsh plugin` supports four install sources, shown here with the `web` profile; `headless` and other CLI profiles work the same way. **DSH Desktop users**: the `desktop` profile is managed through the `dsh` CLI bundled with DeepSeek Harness Desktop — see the end of this section.

| Source | Command | Notes |
| --- | --- | --- |
| npm registry (recommended) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Pre-built artifacts, ready to use |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Builds automatically from source on install; `allowBuilds` must name this package's exact key — pin a version |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Pre-built offline package, handy for air-gapped or offline delivery |
| From source | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` to a local checkout — best for development; no `allowBuilds` needed |

#### Install from npm (recommended)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

`latest` is currently the stable `v0.1.24`; install the beta prerelease (`v0.1.25-beta.2` here) by naming `@beta` explicitly:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace@beta
```

#### Install from a tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# or download the tgz from the GitHub Release assets, e.g.:
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.25-beta.2/dsh-electron-dsh-plugin-multi-root-workspace-0.1.25-beta.2.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.25-beta.2.tgz
```

Also pre-built, handy for air-gapped or offline delivery.

#### Install from GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

A GitHub install fetches source code and builds it automatically during `add` — no manual build needed. pnpm blocks the package's own `prepare` and prints one exact key (including the source and commit); copy that line verbatim under `allowBuilds` and re-run `add`:

```yaml
allowBuilds:
  # Key and value come from pnpm's "Add the package to allowBuilds" example;
  # a bare package name without the source and commit does not apply to git sources.
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

Pinning a version (e.g. `#v0.1.25-beta.2`) is recommended so a later push cannot silently change what actually runs:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.25-beta.2
```

#### Install from a local clone

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

<details>
<summary>Running</summary>

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

The upstream `fs-sandbox` and `sandbox` rows are disabled and taken over by the plugin's same-named services, and all the plugin's `multi-root-*` rows are mounted. After startup, a **Folders** action (workspace-tree glyph) appears at the sidebar foot; DSH `0.2.1-alpha.3` and newer also show the same entry at the right edge of the New Session hero row.

</details>

#### Install with DeepSeek Harness Desktop's built-in CLI

DeepSeek Harness Desktop can install a global `dsh` command from its application menu (**Manage dsh Command…**); use that command to manage the `desktop` profile.

1. Fully quit Desktop, including the tray icon.
2. Fresh install:
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.25-beta.2
   ```
3. Already installed but missing the bundle entry: `remove`, then `add` (re-running only `add` does not register it):
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.25-beta.2
   ```
4. Open `$DSH_HOME/profiles/desktop/package.json` (normally `~/.dsh/profiles/desktop/package.json` when `DSH_HOME` is unset) and confirm `dsh.profile.bundles` contains the package.
5. Start Desktop again (cold start).

If the `add` exits 0 but the plugin never lands in `dsh.profile.bundles`, do a `remove` + `add`. The hot-enable cause, reproduction, and the investigation of profile writes are in [troubleshooting](./docs/troubleshooting/desktop-install-missing-bundle.md) (Chinese).

### Install from the Web / Desktop GUI plugin manager

Web and Desktop install from the sidebar's **Plugins** page: choose **Add plugin**, enter `@dsh-electron/dsh-plugin-multi-root-workspace`, and install it. Then choose **Enable now** — installing alone does not enable the plugin. If the Plugins page has no **Add plugin** entry, use the CLI above.

Restart the DeepSeek Harness app after installing or enabling the plugin: quit Desktop fully (including the tray icon) and reopen it, or restart the `dsh web` process. Enabling this plugin in a running app can fail with duplicate `fs` / `sandbox` registration; a restart loads it cleanly.

## Usage

### Command

```text
/workspace-folders [list]                                                   # list the primary root and the additional roots (access and state included)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # no path opens the directory picker; new roots default to inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # shortcut for /workspace-folders add
/workspace-folders access <n|path> inherit|read-only|read-write             # switch access (widening requires the root to be available right now)
/workspace-folders skills <n|path> on|off                                   # toggle this root's Skills without changing write access
/workspace-folders alias-id <n|path> <kebab-case>                           # edit the stable Skill namespace
/workspace-folders alias <n|path> [name]                                    # omitting the name clears the alias
/workspace-folders remove <n|path>                                          # n is the number list prints
/workspace-folders reveal <n|path>                                          # show it in the file manager
/workspace-folders isolate-profiles [--apply]                               # inspect (--apply writes) profile import method
/workspace-folders help                                                     # show the command help
```

- Paths may be quoted and `~` expands; a duplicate, a nested path, the workspace root itself, and protected paths such as `$DSH_HOME` / the Registry storage directory are rejected.
- `remove` / `access` / `alias` / `reveal` accept `n|path`; `add` without a path opens the directory picker (when the host provides one), and may also be given only the access flag.
- `list` shows each root's access and state. A temporarily missing directory (`missing`) or one replaced by a link elsewhere (`redirected`) keeps its registration but is not granted; it recovers on the next `list` or Workspace folders refresh.
- `isolate-profiles` is a Windows restricted Full-access preflight: it checks each profile's `packageImportMethod` under `$DSH_HOME`, and `--apply` writes `copy`; it does not delete `node_modules` or change existing dependencies.

### Access levels

| Access level | `workspace-write` session | `read-only` session | `danger-full-access` session |
| --- | --- | --- | --- |
| `inherit` (default for new roots) | writable | refused | unrestricted |
| `read-only` | refused | refused | refused (including Full-access) |
| `read-write` | writable | writable | writable |

- New roots default to `inherit`. An access change constrains only later calls and new processes; running processes and persistent terminals keep the access they started with.
- A user-approved one-shot `danger-full-access` escalation on a single call lifts that call's read-only-root and per-tool-cap refusals; `$DSH_HOME` and the unavailable-authority downgrade still apply.
- A primary root accepts at most 16 additional roots (`maxAdditionalRoots` can raise it to 64). A host can permanently cap a tool for all additional roots with `toolAccess` on the `multi-root-scope` row — e.g. `{ bash: 'read-only' }` keeps bash from writing any additional root (it can still write the primary root).

### Additional-root Skills

- Skills are discovered in each additional folder's `.dsh/skills` and `.agents/skills`; names and descriptions are available before the first model step, and bodies load on demand.
- The primary root uses `/skill-name`; additional roots use `/alias-id:skill-name` (Slash completion available). The model calls them through the native `skill` tool, so internal IDs can appear in tool logs.
- New `inherit` / `read-write` roots enable Skills by default; `read-only` roots disable them. The dialog has a per-root switch and editable `aliasId` (renaming the display Alias does not change `aliasId`). Enabling Skills on a read-only root grants no write access.
- In the sidebar's **Plugins** page, open the Multi-root Workspace detail page; **Enable additional-root Skills** on its settings card controls all additional roots and defaults to on. Disabling stops new discovery and invocation while keeping each root's choice; primary-root Skills, instructions, LSP, file browsing, and sandbox permissions are unaffected.

### Worktree root suggestions (experimental, off by default)

When the primary root is a Git worktree root, the plugin lists the repository's other worktrees as candidates in one suggestion card — including worktrees created earlier by a terminal, IDE, or forge; when the session is itself a linked worktree under `workspace-write`, the repository's main checkout is a candidate too. Discovery reads Git metadata only and starts no Git subprocess; it **never adds or removes a root on its own**, and a `danger-full-access` session gets no prompt. In the sidebar's **Plugins** page, open the Multi-root Workspace detail page and turn on **Enable worktree root suggestions** on its settings card (off by default).

The suggestion is a persistent card: choose **View** or **Remind me later** (until a new worktree appears / in 7 days / in 30 days); the close button only dismisses this notice and it returns after a restart. After it closes, reopen it from **Worktree suggestions** beside Retry in the **Workspace folders** dialog. The confirmation dialog lists each path, branch, and access (default `inherit`, changeable to read-only or read-write), with checkboxes when several candidates exist; the main checkout row additionally states its scope: the main checkout source tree, shared config/hooks/refs/objects, and every worktree's admin data, which may affect other checkouts of the same repository. A registration is workspace-wide, so **other read-write sessions also gain the chosen access**; the dialog re-validates every row on confirm, and any change in the meantime invalidates that row. The dialog also offers **Never remind me again**.

When a worktree is deleted or moved, the dialog shows a badge, but **nothing is ever cleaned up automatically**; cleanup is offered only when the directory is confirmed missing and the registration identity matches (batch or per row), behind a confirmation dialog layered over it. Before cleanup, a new directory at the same path can inherit the old grant; the dialog discloses that risk.

### Auto Review integration (experimental, off by default)

For multi-root review context, enable the default-disabled Auto Review row in the component list of the Multi-root Workspace detail page on the **Plugins** page; the experimental **Multi-root Auto Review** switch on the same settings card is equivalent and also off by default. Ordinary installation neither enables nor selects Auto Review; the integration is available only on the DSH exact releases that ship it.

### SSH remote environments (experimental, off by default)

Issue #32 currently exposes personal SSH only. Turn on **SSH remote environments** in the plugin settings and confirm the risk prompt. The local DSH Host holds the SSH credentials, which processes running under the same OS account may be able to access. Open **Remote SSH → Manage** from plugin settings or **Manage SSH remotes** from Workspace Folders.

**Personal mode.** Open “Manage SSH remotes” → “Add connection”. Enter the host and credentials, then confirm the host key to save the connection. In step two, detect Node, install the helper, then select “Allow command execution” and click “Finish” to save. Return to Workspace Folders and open “Manage remote Root bindings”. Choose a saved connection, choose a directory and set its permissions, then register it from the More menu in its remote directory row. You can bind several directories through the same connection.

The tools require a compatible SSH runtime, and the Registry authorizes each call against the registered directories for the current workspace. Turning SSH off unloads the tools and closes the remote control plane. See the [SSH remote environments guide](./docs/guide/user/ssh-remote-environments.en.md) for the full workflow.

### UI entries

- **Sidebar and New Session page**: the **Folders** action at the sidebar foot opens the **Workspace folders** dialog; from DSH `0.2.1-alpha.3`, the same entry sits at the right edge of the New Session hero row (no chevron; icon-only in narrow windows). The dialog adds/removes roots, edits aliases and access, toggles Skills per root, copies paths, reveals in the file manager, offers Retry plus the Worktree suggestions entry.
- **Workspace row menu**: the workspace row's `…` menu and context menu include **Manage workspace folders…**. When the current session belongs to that workspace it opens directly; otherwise it first opens or reuses that workspace's blank session and opens after the session becomes current.
- **Files tab**: the header root switcher switches between the primary root and any additional root; with an additional root selected, the tree, opening files, open-in-app, context menus, auto-refresh, and workspace search all follow that root, and switching back restores the native view.

### Model side

The additional-root topology is injected into the system prompt and updates when grants change; no new tool is needed. An additional root's own `AGENTS.md` / `CLAUDE.md` also reach the model as they become relevant: the top-level file before the session's first step, and a subdirectory's after this session has successfully worked in it.

For fuller feature-by-feature instructions, see the [user guides](./docs/guide/user/README.en.md).

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
│   └── client/                       the browser half: sidebar action, the Folders dialog, the Files-tab root switcher, dictionaries for DSH's eight languages
├── tests/                            differential parity, real-execution dialect matrix, contract round-trips, component and locale gates, cross-process lease e2e, instruction injection
├── scripts/                          smoke batteries (compose / behavior / journey) plus the docs, kernel-runner, compatibility-contract and upgrade checks
└── docs/                             requirements, architecture, decision records (ADRs), plans, development workflow
```

## Contributing

Issues and PRs are welcome:

1. Read [`AGENTS.md`](./AGENTS.md) (repository-wide rules) and the [development workflow](./docs/development/plugin-development-workflow.md) (environment, commands, the runtime support matrix, the upgrade procedure) first.
2. Branch from `main`; follow conventional commits (`feat` / `fix` / `perf` / `refactor` + scope) — see the existing history.
3. All of these must pass locally before a PR: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (CI runs the same order, build before test).
4. Behavior changes update the matching document under `docs/` in the same change; keep the eight root README editions in sync (Chinese is canonical); record engineering decisions that involve trade-offs as ADRs.
5. Hard constraint: **never modify any package of the upstream repository (deepseek-harness)**; the plugin stays an out-of-tree extension.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Known Limitations

### Plugin features

- An additional root's instruction files arrive as they become relevant: the one at the root's top level is injected before the session's first step, and a subdirectory's is injected once the session has **successfully** worked in that directory. A nested file is re-examined only when its directory is examined (the root's own every step; a subdirectory's because it was delivered from, or because of a fresh touch), delivery state is in-process (so a resumed session may be told again); officially the `read` / `write` / `edit` tool names count, and OPS tools also drive delivery through live evidence when OPS compatibility mode is enabled (OPS history without live evidence does not count after a resume). The primary root's chain and the user-global file remain upstream's job, and this plugin does not inject them a second time ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Hosts share one Registry service: one Host owns storage and each instance obtains admission for new operations. Disconnection stops new additional-root grants; a successor takes over through the kernel lease. Sharing is local to one user and lock namespace; Linux requires SO_PEERPIDFD, and Windows is limited to one login session. Existing processes and PTYs retain their launch snapshot ([architecture](./docs/architecture/registry-authority-service.md), Chinese).
- The supported matrix is an exact-version allowlist: on a host whose release is not on the list, or whose core packages disagree about the release, the `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` rows **do not start** and the composition degrades to "the plugin is not installed" ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- The Windows multi-root runner inherits upstream partial enforcement, caller-owned directory requirements, and private-temp isolation. Running processes retain their initial roots; later processes use the updated set ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Network and device paths cannot be additional roots on Windows**: UNC (`\\server\share`), `\\?\`, `\\.\`, and mapped network drives are rejected at registration with `unsupported-path` — the restricted token's capability SID cannot be shown to bind SMB access ([ADR-0011 amendment](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **The confined Windows shell is pwsh; Git Bash is not available**: MSYS cannot start under the write-restricted Low-integrity token (identically under the upstream and plugin runners — an upstream limitation). An upstream-confined child also cannot receive Ctrl+C (it inherits the runner's ignore flag); under the plugin runner Ctrl+C reaches the child and the runner mirrors its exit code.
- Additional-root access is three-state: new registrations default to `inherit` (they follow the session mode), `--read-only` refuses writes in every mode (including Full-access; the only exception is a user-approved one-shot escalation on a single call — [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), and a fixed `--read-write` stays writable even in a read-only session — it is a question of write authority, never read confinement ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). A running process or persistent terminal keeps the deny set it was started with — a terminal started before a root turned read-only stays unrestricted until restarted; cap and access changes constrain only later calls and new processes ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); hosts with workingDirectory may use an additional root as the execution directory for later tools, while the session origin and registry identity stay unchanged ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **On Linux hosts where upstream selected Landlock, a restricted Full-access needs bubblewrap**: Landlock's allowlist cannot express "everything writable except these roots", so that combination selects bwrap to spell the deny boundary; on a host without a usable bwrap (not installed, or unprivileged user namespaces disabled), a Full-access command that carries any deny boundary (a read-only root, or the protected `$DSH_HOME`) fails closed at launch. Enable bwrap there, or avoid explicit read-only roots under Full-access on such hosts ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- Browse additional roots from the **Files tab's root switcher**: the header entry lists the primary root and every additional root, with the selected root's full path still shown beside it; selecting one lets a byte-for-byte fork of the upstream Files tree take over the tree area (lazy-loaded directories, native rows and icons, watch-driven auto-refresh, file clicks opening in the host viewer, plus a manual refresh in the header's reload spot), and the header's open-in-app button is simultaneously replaced by a byte-for-byte fork of the upstream control that opens the selected root instead of the primary one; switching back to the primary root restores the native view. The dialog is management-only again. Additional-root rows also get the same row context menus as the primary root (file and directory rows; the document preview's Folder navigator too), and the selected root gets workspace search (header toggle, search bar, highlighted results tree, preferences popover, hidden-entry filtering); both appear only where the host exposes the corresponding structure — row menus need `useContextMenu` (`0.2.2-alpha.3` and newer), search needs `workspaceFiles.search` (`0.2.2-rc.2` and newer), and older hosts bind no row menus and render no search entry, leaving the view unchanged. The takeover relies on upstream `data-*` DOM hooks and degrades silently to the native look when they stop matching ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). LSP uses the containing additional root as its own workspace; the host must configure the relevant language server ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)). Known boundaries: the native Files shortcut (Cmd+P) still focuses the native search field the takeover keeps hidden, so it is not an additional-root search entry — neither the Files page nor the preview navigator's search surface responds to it ([ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md), [ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)); the preview navigator keeps its search records per `(pane, root)`, separate from the Files page's `(tab, root)`, so a query typed on the Files page does not carry into the preview; the result current row is marked but not scrolled into view; and closing Folder or switching roots in one pane discards an uncommitted settings draft ([ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)).
- When a third-party extension takes the whole Files page over (registering the `files` kind with `priority: "extension"`), the root switcher and additional-root browsing are unavailable; the plugin shows one info-level transient notice and rearms after the takeover ends, while roots stay manageable from the sidebar's Workspace Folders entry and `/workspace-folders` ([Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)).
- The command's own output text is English (a host-side handler has no active locale to consult); the panel follows the interface language and ships in all eight languages DSH provides.
- The Workspace Folders panel is a sidebar footer action plus a dialog rather than a full panel: `sidebar.footer.action` is offered by every supported release, whereas `sidebar.panellist` / `main` are not. Since DSH `0.2.1-alpha.3`, an incremental entry also rides the New Session hero row's `conversation.hero.options` slot: it shares the adjacent workspace and mode selectors' geometry, has no chevron, shrinks with the room measured inside the hero row, and degrades to a 28×28 icon button under 88px (the upstream options container is `flex: none`, so the plugin measures the leftover room and clamps itself instead of changing DSH; an unrecognized row structure falls back to the 560px viewport step). Where an older runtime does not declare that slot, the registration silently stays out and the sidebar entry is unaffected ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md), Chinese). The sidebar entry's rail (collapsed) rounding has its own earlier boundary, `0.1.6-alpha.2`: 23 supported releases draw the same 12px rounded square as the host, while the two oldest (`0.1.5-rc.2`, `0.1.6-alpha.1`) draw the host's circle against the plugin's 12px rounded square — the documented rounding deviation, with no ink or layout effect. The `@media (hover: hover)` wrapper exists only on the six token-geometry releases and the recipe deliberately leaves it unwrapped, so touch devices differ from those releases in hover feedback ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)). The sidebar entry's height follows the settings-row occupant through a CSS structural dependency on the account launcher's `data-signed-out` marker (not a slot contract): the seven oldest releases (through `0.1.7-rc.2`) keep the 42px settings-trigger height, from `0.2.0-rc.1` the button takes 32px signed out / 44px signed in, the rail stays 36px, and a renamed or missing marker falls back to 42px instead of mis-sizing ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)).

### OPS adaptation

The implementation is available through **OPS compatibility mode (experimental, off by default; limitations may apply)**. Set `multi-root-ops-compatibility.enabled` under `Settings → Plugins → Multi-root Workspace`; it defaults to `false` and requires an explicit opt-in. This feature can only be enabled on DSH `0.2.*` releases within the existing exact support matrix. On `0.1.*`, even a manually configured `enabled: true` stays inactive, and the legacy Settings UI is not supported ([version-scope decision](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06), Chinese). Enabling it from Settings opens the host’s risk dialog: acknowledge the limitations and confirm before the setting is saved. Cancel, close, or press Esc to keep it disabled.

- **Enabled**: activates OPS execution protection, live activity, and Review enhancements. Full-access (`danger-full-access`) enforces explicit RO/cap deny boundaries through kernel confinement on the verified macOS and Linux lanes. On Windows, deny-bearing OPS execution calls, including reads, are conservatively refused before Worker preparation; protected preparation and legal writes in that combination are not yet supported. In WW/RO, any non-writable additional root or tool write cap causes the entire OPS execution call, including reads/page, to be refused before preparation and execution. All modes refuse OPS execution when Registry authority is unavailable; pure discovery/publication remains available. Subprocess launches also require a protected execution domain or a profile from the current admission, preventing background cleanup from bypassing boundaries. This can also reject third-party background processes; the panel’s user terminal is unaffected.
- **Disabled**: restores OPS behavior from before this adaptation, without these safeguards — **OPS may write to an explicitly read-only additional root**. Normal multi-root features, native tool fences, and Auto Review's own toggle are unaffected. Delivered instructions are not retroactively erased; calls already inside a protected execution domain and running processes retain their original snapshot. Newly started calls no longer activate this adaptation.
- **Experimental limitations**: only the Phase-A live activity index is available; there is no durable event bridge. While enabled, OPS history without live evidence after resume and dynamic pending actions (replace/batch/result/bash/unknown) cause Review to fail technically. Non-allowlisted diagnostics such as `ops_status` are also subject to this conservative rule.

Specific known gaps:

- **dsh-ops bypassed an explicit read-only root restriction (F01, historical baseline)**: in the audited versions under Full access, the Native `ops_write_file` tool actually changed a file in an additional root pinned read-only, while the native filesystem control was denied. With OPS compatibility mode enabled, this round's limited adaptation makes the explicit RO/cap deny boundary effective for OPS Native and real PTC under Full access (deny-execution re-verification in [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); see the [compatibility audit](./docs/reviews/dsh-ops-compatibility-audit.md) (Chinese) for versions, scope, and original evidence.
- **Legal additional-root writes and nested instructions had gaps with dsh-ops (F04/F05, historical baseline)**: OPS preflight still rejects inherited or pinned read-write additional roots under workspace-write and pinned read-write roots under read-only (F04 unresolved). The nested-instruction gap (F05) is re-verified as recovered with the mode enabled this round: with the live index, real AgentLoop evidence shows successful Native and PTC touches delivering the subdirectory chain into the next model request (see [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)). The tested root-level instructions and Skills paths still work.
- **Linux bwrap workspace-write batch/result is degraded (F07)**: with the audited shared Registry composition, every `ops_batch` / `ops_result` call (including `page`) that reaches the launch branch with a valid cache loses its argv ownership proof when OPS adds a bind after confinement. The source path rejects the Worker launch with `EXECUTOR_UNAVAILABLE`. The function-level conflict is reproduced; Linux end-to-end execution is untested. Ordinary read-only, Landlock, and no-cache controls are outside this conclusion. An OPS interface to declare cache requirements before confinement is needed; no MR-only workaround has been validated. See [F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Other OPS availability limits**: under shared workspace-write, purge outside dispatch is rejected without a live admission, so result caches may remain with a warning. Nested PTC calls and background Bash also risk rejection from mismatched or expired proofs. The conservative refusal boundaries have been validated on all three platforms. Normal background execution and cleanup remain unavailable and are deferred indefinitely; see the [final scope in ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05) (Chinese).

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

Third-party licenses: [THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
