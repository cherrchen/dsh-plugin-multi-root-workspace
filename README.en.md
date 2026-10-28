<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

[中文](./README.md) | English

</div>

## What & Why

By default, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) treats the directory a new workspace is created in as the agent's primary directory; under the default workspace read-write mode (`workspace-write`), the sandbox's read-write scope covers that directory alone. This plugin extends DSH's workspace scope to "one primary root + N additional roots".

Not every project is a monorepo. A real development project is usually several independent Git repositories, and working across them meant juggling sessions. Peer harnesses already support adding multiple folders to a single workspace. This plugin brings the same capability to DSH — register the other repositories as additional roots, grant each read-only, read-write, or unrestricted access, and the agent can work in them within that grant.

- **No new tools**: the agent keeps using the native `read` / `write` / `edit` / `bash`; only the granted directories grow.
- **Sandbox confinement**: an additional root may inherit the session's (primary root's) permission setting, or be pinned to read-only or read-write; under read-only and read-write, confinement does not rest on system prompts — it is enforced by an in-process filesystem fence plus kernel-level sandboxes (macOS Seatbelt / Linux bwrap / Landlock / Windows ACL), with files and bash sharing one and the same scope.
- **Optional Auto review (off by default)**: a fork of upstream's experimental auto-review that gives the reviewer the additional directories' context — the current workspace topology, each root's access level, and live instruction files; it ships disabled and only takes effect once the `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review` row is explicitly enabled in the Plugin Manager row list, taking over the official bundle while on.
- **Additional-root Skills**: discovers `.dsh/skills` and `.agents/skills` inside additional folders, invoked through the namespaced `/alias-id:skill-name` reference and the native `skill` tool; each root has an independent toggle and editable `aliasId`, with a global setting that defaults to on.
- **Absent when absent**: with no additional root configured, its behavior is item-for-item identical to an uninstalled harness; every misconfiguration fails loudly instead of silently degrading.

Current released version: `v0.1.10`. The user-visible changes of each version live in the [CHANGELOG](./CHANGELOG.en.md); progress and release state live in the [roadmap progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Quick Start

The plugin is published on [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). Open the **Plugins** page in the sidebar, choose **Add plugin**, and paste the package name `@dsh-electron/dsh-plugin-multi-root-workspace` — or install it in two commands:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # pick the --profile for how you launch DSH; see its docs for the values
```

Once it is up, the **Folders** action (`🗂`) appears at the sidebar foot — or, straight in a session:

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
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4` |
| `0.2.2` | `0.2.2-alpha.2` |

The plugin does not start — as if it were not installed — when the DSH release is not in the table or the `@deepseek-ai/dsh-*` packages disagree on a version.

**Building from source / contributing**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (enable via corepack); the dev-pinned DSH is `0.2.2-alpha.2` (Node ≥24.9).

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
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.10/dsh-electron-dsh-plugin-multi-root-workspace-0.1.10.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.10.tgz
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

Pinning a version (e.g. `#v0.1.10`) is recommended so a later push cannot silently change what actually runs:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.10
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

The upstream `fs-sandbox` and `sandbox` rows are disabled and taken over by the plugin's same-named services, and all the plugin's `multi-root-*` rows are mounted. After startup, a **Folders** action appears at the sidebar foot.

## Usage

### Command

```text
/workspace-folders [list]                                                    # list the primary root and the additional roots (access and state included)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write]  # no path opens the OS directory picker; new registrations default to inherit
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

Access is three-state ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md); the [usage guide](./docs/guide/README.en.md#access-levels-the-root-limit-and-per-tool-caps) has the exact semantics): `inherit` follows the session mode — writable under `workspace-write`, refused under `read-only`, unrestricted under `danger-full-access`; `read-only` refuses writes in every mode, including Full-access; a fixed `read-write` root stays writable even in a read-only session. Writable records registered by older plugin versions read back as `inherit`. A primary root accepts at most 16 additional roots (`maxAdditionalRoots` can raise it to 64). A host may also cap a tool for all additional roots via `toolAccess` on the `multi-root-scope` row — e.g. `{ bash: 'read-only' }` keeps bash from ever writing an additional root (it can still write the primary root).

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

### Panel

The **Folders** dialog at the sidebar foot lists the primary root and the additional roots, and offers add, remove, alias, read-only/read-write switching, copy path, and reveal in the file manager.

### Model side

The additional-root topology is injected into the system prompt so the model knows which directories are available, and the information updates when grants change. No new tool needs to be exposed to the model.

## Optional Auto Review integration

For multi-root reviewer context, enable the default-disabled [Auto Review row](./src/auto-review/README.en.md) in the main package’s Plugin Manager row list. The joint integration targets only DSH `0.2.1-rc.2`; ordinary installation keeps the existing support matrix and does not enable or select Auto.

## Project Structure

```text
.
├── src/
│   ├── roots.ts                      pure rules: canonicalization, conflict validation, record classification (available/missing/redirected/invalid)
│   ├── registry.ts                   the root registry: dsh-storage-domain persistence, mutations of one primary root serialized in one queue
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

- An additional root's instruction files arrive as they become relevant: the one at the root's top level is injected before the session's first step, and a subdirectory's is injected once the session has **successfully** worked in that directory. A nested file is re-examined only when its directory is examined (the root's own every step; a subdirectory's because it was delivered from, or because of a fresh touch), delivery state is in-process (so a resumed session may be told again), and only the `read` / `write` / `edit` tool names count. The primary root's chain and the user-global file remain upstream's job, and this plugin does not inject them a second time ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Single writer per store: only one DSH process at a time may hold the root registry for a given `$DSH_HOME`; another process reports the registry as unavailable (`registry-contended`) and takes over on refresh once the holder exits or crashes. That is deliberate fail-closed behavior, not a race waiting to be fixed ([ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md)).
- The supported matrix is an exact-version allowlist: on a host whose release is not on the list, or whose core packages disagree about the release, the `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` rows **do not start** and the composition degrades to "the plugin is not installed" ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- The Windows multi-root runner inherits upstream partial enforcement, caller-owned directory requirements, and private-temp isolation. Running processes retain their initial roots; later processes use the updated set ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Network and device paths cannot be additional roots on Windows**: UNC (`\\server\share`), `\\?\`, `\\.\`, and mapped network drives are rejected at registration with `unsupported-path` — the restricted token's capability SID cannot be shown to bind SMB access ([ADR-0011 amendment](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **The confined Windows shell is pwsh; Git Bash is not available**: MSYS cannot start under the write-restricted Low-integrity token (identically under the upstream and plugin runners — an upstream limitation). An upstream-confined child also cannot receive Ctrl+C (it inherits the runner's ignore flag); under the plugin runner Ctrl+C reaches the child and the runner mirrors its exit code.
- Additional-root access is three-state: new registrations default to `inherit` (they follow the session mode), `--read-only` refuses writes in every mode (including Full-access), and a fixed `--read-write` stays writable even in a read-only session — it is a question of write authority, never read confinement ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). A running process or persistent terminal keeps the deny set it was started with — a terminal started before a root turned read-only stays unrestricted until restarted; cap and access changes constrain only later calls and new processes ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); hosts with workingDirectory may use an additional root as the execution directory for later tools, while the session origin and registry identity stay unchanged ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **On Linux hosts where upstream selected Landlock, a restricted Full-access needs bubblewrap**: Landlock's allowlist cannot express "everything writable except these roots", so that combination selects bwrap to spell the deny boundary; on a host without a usable bwrap (not installed, or unprivileged user namespaces disabled), a Full-access command that carries any deny boundary (a read-only root, or the protected `$DSH_HOME`) fails closed at launch. Enable bwrap there, or avoid explicit read-only roots under Full-access on such hosts ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- Browse additional roots from the **Files tab's root switcher**: the header entry lists the primary root and every additional root, with the selected root's full path still shown beside it; selecting one lets a byte-for-byte fork of the upstream Files tree take over the tree area (lazy-loaded directories, native rows and icons, watch-driven auto-refresh, file clicks opening in the host viewer, plus a manual refresh in the header's reload spot), and the header's open-in-app button is simultaneously replaced by a byte-for-byte fork of the upstream control that opens the selected root instead of the primary one; switching back to the primary root restores the native view. The dialog is management-only again. The takeover relies on upstream `data-*` DOM hooks and degrades silently to the native look when they stop matching ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). LSP uses the containing additional root as its own workspace; the host must configure the relevant language server ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- The command's own output text is English (a host-side handler has no active locale to consult); the panel is bilingual.
- The Workspace Folders panel is a sidebar footer action plus a dialog rather than a full panel: `sidebar.footer.action` is offered by every supported release, whereas `sidebar.panellist` / `main` are not.

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
