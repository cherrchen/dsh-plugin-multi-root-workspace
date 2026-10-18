# Changelog

This file records the user-visible changes of every **released** version.

中文：[CHANGELOG.md](./CHANGELOG.md)

- The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
- For installation sources, the supported upstream runtimes, and known limitations, see the [README](./README.en.md).
- The evidence, numbering, and release state of each version live in the [roadmap progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账). The body of each GitHub Release is generated from the commit history by `scripts/release-notes.mjs` and is the complete raw list behind this file.

## [0.1.8] - 2026-10-18

### Fixed

- **Permission settings page unavailable on DSH 0.2.0**: when installed via `link:`, the plugin resolved optional packages it never loads — packages consumed only as mounted host services (`dsh-lsp` / `dsh-lsp-stdio` / `dsh-working-directory`, among others) — to the checkout's own devDependencies, so a uniformly-versioned host was misjudged as `mixed`; and because the two replacement provider rows injected the compatibility gate while upstream `fs-sandbox` / `sandbox` were already disabled unconditionally, a refused gate removed `ctx.fs` / `ctx.sandbox`, taking down `ctx.shell` and `permissionPresets` with it (`permissionPresets/catalog` reported `service-unavailable`). Optional packages are now classified by who loads the resolved copy and through which anchor — runtime-loaded, host-service, or runner-anchored — so host-service copies inside the plugin root no longer testify, and the Windows ACL package is inspected from the `dsh-sandbox-local` anchor; the two provider rows no longer inject the gate and degrade to upstream-equivalent behavior on a refused installation, while every widened-authority row stays gated (see [ADR-0009 amendment](./docs/decisions/ADR-0009-dsh-compat-contract.md#修订2026-10-18permissionpresetscatalog-事故误报检测--被门禁的-provider)).

## [0.1.7] - 2026-10-17

### Added

- **Browse additional roots inside the Files tab**: a root switcher sits in the file-tree header (a menu entry disguised as the path label, listing the primary root plus every additional root and its state); picking an additional root hands the tree area to a byte-for-byte fork of the upstream Files tree — row height, icons, indent, and the empty state match natively item by item, the native reload is replaced by an identical icon button at the header's original spot, and switching back to the primary root restores everything. The native open-in-app button is replaced by a fork that retargets to the selected root ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). Panel rows carry an access badge, every path copies through the same `PathCopy` control in one tap, read-only → read-write promotion goes through a confirmation layer, and the add-row access picker is an anchored dropdown.
- **Per-root access levels are now three-state**: `add [--inherit|--read-only|--read-write]` (or the panel's add-row selector). `inherit` follows the session mode — it is the default for new registrations, and writable records stored by older plugin versions migrate to it; `read-only` stays readable, browsable, and part of LSP and instruction delivery but grants no write authority in any mode, including `danger-full-access`; a fixed `read-write` stays writable even in a globally read-only session. `/workspace-folders access <ref> inherit|read-only|read-write` and the panel switch access per root (widening requires the root to be available and never re-authorizes its path). The persistence layout stays downgrade-safe: an older plugin reads a read-only record as invalid rather than upgrading it to writable ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md), [ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **Full-access now enforces deny boundaries too**: the shell / pwsh executors, `run_code` (PTC), and agent PTYs all bypass `confine` in `danger-full-access`, so a process fence puts them under a restricted kernel profile (macOS Seatbelt, Linux bwrap — a host where upstream selected Landlock uses bubblewrap the same way, and refuses the combination at launch when bwrap is unusable); explicit read-only roots and tool-capped members stay denied in that mode, and the fs fence reads the same deny set ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **A restricted Full-access also protects `$DSH_HOME`**: whenever any deny boundary exists (a read-only root, a tool-capped member, or an unavailable registry authority), the home directory joins the deny set — the durable store, the registry lease, and user profiles live there; with zero additional roots and a healthy authority Full-access stays byte-identical to upstream ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **Your panel terminals are never confined**: the process fence only prefixes spawns whose env carries `DSH_PTY_SESSION_ID` (stamped by the terminal-bash backend for agent PTYs); a terminal you open from the panel is user behavior and passes through in every mode ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **Selective read-only under Windows Full-access**: an opt-in, administrator-installed per-user privileged broker ships with the package — the installer grants a fixed set of LSA rights (`SeServiceLogonRight`, `SeCreateTokenPrivilege`, `SeAssignPrimaryTokenPrivilege`, `SeTcbPrivilege`, `SeDebugPrivilege`, `SeImpersonatePrivilege`) to the dedicated virtual service account `NT SERVICE\DshMultiRootBroker-<install hash>` only and never elevates the host user; the broker builds a normal deny-only group token for the restricted child, which the runner reads back and verifies before letting it run. Without the broker the combination refuses to launch; Windows enforcement still honestly reports its partial boundary ([ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)).
- **Per-tool write caps**: configuring `toolAccess: { <tool>: 'read-only' }` on the `multi-root-scope` row makes that tool permanently unable to write any additional root (the primary root is unaffected); enforcement rides the real `tools/execute` dispatch context, and invalid configuration fails closed ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)).
- **Additional-root limit**: each primary root stores at most 16 additional-root records by default (`maxAdditionalRoots`, up to 64); new additions past the limit are refused while over-limit history keeps granting. `list` prints `N of LIMIT` honestly ([ADR-0014](./docs/decisions/ADR-0014-root-limit-and-provider-conflict.md)).
- **Provider-conflict detection**: when another plugin also replaces `ctx.fs` / `ctx.sandbox`, the multi-root rows fail loudly and grant nothing instead of depending on load order ([ADR-0014](./docs/decisions/ADR-0014-root-limit-and-provider-conflict.md)).
- **Exact support for DSH `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, and `0.2.1-rc.2`**. Since `alpha.3`, upstream `dsh-storage-domain` pins `zod` at `4.4.3`, and the two resolved zod copies' types are mutually incompatible, so the domain schemas are now built by the zod the storage domain itself resolves. Since `alpha.4`, upstream version requirements prefer `engines.dsh`; this plugin still keeps `peerDependencies` as its single version contract. The dev pin moves to `0.2.1-rc.2` (cordis `4.0.5`; `alpha.3`–`alpha.5` use cordis `4.0.5-alpha.2`).

### Changed

- **Model-facing topology rewritten**: the prompt states authority truthfully per mode and platform — writable and read-only roots listed separately, cd/worktree switches do not change grants, grant changes constrain only later operations and new processes, capped tools are named, and Windows adds the restricted-token partial-enforcement caveat plus the note that reads are not confined by it ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)).

### Fixed

- **An unavailable registry authority no longer reads as "no restrictions"**: a process that read an empty root table (contended, storage failure, invalid configuration) used to let Full-access write anywhere; `danger-full-access` and `workspace-write` now grant writes only to the primary root (the shared platform temp areas are no longer writable), explicit deny boundaries still win, and the real scope returns once the lease is taken over ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **Renaming an ancestor can no longer lift a read-only boundary**: renaming a denied root's parent used to move the tree outside its path-based restriction. Seatbelt now also denies writes to each ancestor directory itself (`(literal …)`), and bwrap self-binds ancestors into mountpoints so rename fails with EBUSY. Windows pins the root and its ancestors with directory handles that disallow delete sharing until the restricted Job's descendants have drained, preventing a shell rename followed by a host file-tool bypass. These mechanisms constrain ancestor renames or metadata operations ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md), [ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)).
- **Negative authorization survives reordering, disappearance, and conflicts**: overlapping stored registrations both lose membership grants while retaining their trusted deny boundaries. New registrations also check the reserved boundaries of missing or redirected roots. Globally read-only sessions apply denies after adding fixed read-write roots; backends that cannot express subtree subtraction refuse to launch.
- **Windows checks every deny root for hardlinks before ACL changes**: any multi-link file or uninspectable node refuses startup before any ACL write, avoiding changes to shared objects in the pnpm store or other link locations. The host maintenance command `/workspace-folders isolate-profiles [--apply]` inspects by default; explicit apply only sets profile imports to copy. Existing dependencies still require the reported reinstall steps, and historical ACLs are not repaired ([ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)).
- **A deny root that vanished on Linux fails closed instead of opening up**: the root's bwrap mount is mandatory again — when the directory disappears after registration or after the profile is built, namespace setup fails and the command never runs, instead of the path becoming recreatable under a writable parent mount ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- **Re-registering roots preserves their access**: the command and panel omit access unless explicitly chosen, so reviving a read-only registration cannot silently upgrade it; the panel keeps re-registration available for existing unavailable entries at the root limit.
- **The panel accepts older hosts' root lists**: responses without `limit` / `count` remain usable, while explicitly malformed values are still rejected.
- **Invalid toolAccess is reflected in the topology prompt**: the model sees that all additional-root writes are refused instead of being told read-write registrations are writable; a `null` root-limit configuration also fails closed.
- **Confined shell commands work again for installed copies on Windows (DSH 0.1.7-alpha.1+)**: with the published v0.1.6 installed from npm/tarball, the standalone Windows runner died before its first line with `ERR_MODULE_NOT_FOUND` — its static module graph imported upstream packages that cannot be resolved from the plugin's install directory, so every confined command in a session with additional roots failed on the affected releases. The runner's static graph is now `node:` builtins only, and it loads the upstream ACL package by self-reference from the upstream runner's own location.
- **Network and device roots are rejected on Windows**: UNC (`\\server\share`), `\\?\`, `\\.\`, and mapped network drives were previously accepted as ordinary additional roots; they are now rejected lexically as `unsupported-path` before any filesystem access, stored records are marked `invalid`, and the confined-execution side fails closed (`SandboxUnavailableError` / exit 127) rather than silently running unconfined ([ADR-0011 amendment](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **The Windows runner re-verifies roots before spawn**: after the ACL grant and before the child starts, every root must still exist and resolve to the same canonical directory, and `--temp` must be an existing directory; anything else exits 127 without launching an unconfined process.
- **"Reveal in file manager" no longer reports failure on Windows**: `explorer.exe` returns 1 on success, so exit codes 0 and 1 are both accepted on win32.
- **Panel file endpoints reject backslash paths**: on POSIX, `..\..\x` previously resolved inside the selected root; backslashes are now rejected lexically.
- **The Windows broker accepts UAC-filtered callers and diagnoses packaged children**: restricted commands launched by a non-elevated UAC administrator were previously refused for not being an "unrestricted identity"; only callers carrying restricting SIDs or an AppContainer are refused now, and a Store/MSIX child (such as `pwsh.exe` under the WindowsApps alias) gets a diagnostic pointing at the MSI/ZIP build before launch. After upgrading, reinstall the broker once with `install.ps1` for this to take effect ([ADR-0020 amendment](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)).
- **Panel file-tree calls are abortable**: in-flight `files` / `readFile` calls are cancelled on unmount, path, or session change, so stale responses no longer render as errors.

### Changed

- **Confined Windows shell behavior, documented**: the confined shell is pwsh (Git Bash/MSYS cannot start under the restricted token, identically to the upstream runner); under the plugin runner a confined child receives Ctrl+C and the runner mirrors its exit code, while an upstream-confined child inherits the runner's ignore-Ctrl+C flag and cannot receive it — both are established behavior ([ADR-0011 amendment](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- Install note added: if the first install was interrupted by the `koffi` build approval, a successful follow-up `add` may still leave the plugin absent from `dsh.profile.bundles`; one `remove` + `add` activates it ([troubleshooting](./docs/troubleshooting/install-stops-at-build-approval.md)).

## [0.1.6] - 2026-10-11

### Added

- Exact-version support for DSH `0.2.1-alpha.1` and `0.2.1-alpha.2`. Session origin is separated from the dynamic working directory, so changing cwd does not change registry ownership or authorized roots. Adds Worktree management, additional-root LSP routing, Windows kernel-enforced multi-root access, and additional-root file browsing and preview in Workspace Folders.
- Additional-root instructions are restored and re-delivered after cwd changes when still applicable.

### Changed

- Additional-root file trees and LSP routing are isolated per root; Worktree operations do not mutate root-registry authorization.

## [0.1.5] - 2026-09-30

### Added

- Exact-version support for DSH `0.2.0-rc.1` and `0.2.0-rc.2`, while retaining every previously supported release. CI verifies every release in the compatibility contract across the enabled operating systems.

## [0.1.4] - 2026-09-25

With the exact allowlist contract from `v0.1.3` unchanged, the supported upstream runtimes grow to `0.1.7-rc.2`; the reasoning is still [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md).

### Added

- **Support for the upstream runtime `0.1.7-rc.2`**. Relative to `0.1.7-rc.1`, `confine`, instruction rendering, session format 4, the tool-failure bit, panel icons, the current-session catalog, in-process boot, and bash execution keep their shapes, so the adapter layer has no new branch. cordis stays at `~4.0.4`. The install-time peer gate added in `rc.1` still requires this exact release in `peerDependencies`. The development pin remains `0.1.5-rc.2`.

## [0.1.3] - 2026-09-24

With the exact allowlist contract from `v0.1.2` unchanged, the supported upstream runtimes grow to `0.1.7-alpha.2` and `0.1.7-rc.1`; the reasoning is still [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md).

### Added

- **Support for the upstream runtimes `0.1.7-alpha.2` and `0.1.7-rc.1`**. Relative to `0.1.7-alpha.1`, `confine`, instruction rendering, session format 4, the tool-failure bit, panel icons, the current-session catalog, in-process boot, and bash execution keep their shapes, so the adapter layer has no new branch. From `0.1.7-rc.1`, `dsh plugin add` refuses a plugin whose `peerDependencies` do not satisfy the running runtime, which is why both releases have to be on the exact allowlist. The development pin remains `0.1.5-rc.2`.

## [0.1.2] - 2026-09-22

With the exact allowlist contract from `v0.1.1` unchanged, the supported upstream runtimes grow to `0.1.6-alpha.2` and `0.1.7-alpha.1`; the reasoning is still [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md).

### Added

- **Support for the upstream runtime `0.1.6-alpha.2`**, alongside `0.1.5-rc.2` and `0.1.6-alpha.1`. `confine` stays asynchronous and the instruction renderer keeps the `0.1.6-alpha.1` name; the client current-session id now comes from the catalog row's `retainedBy.mainView` (see Fixed). The development pin remains `0.1.5-rc.2`.
- **Support for the upstream runtime `0.1.7-alpha.1`**. `confine` and the instruction renderer keep their previous shapes, but this release needs adapters: session format 4 rejects `kind: 'plugin'`, so additional-root instructions use this plugin's own source kind `multi-root-workspace` (format 3 and earlier still use `plugin`); the tool-failure bit moved from the content block onto the message; panel icons moved from pixel names to the Regular weight; in-process boot uses `createRuntimeResolution` plus `PluginPackages`; bash execution moved from `shell.run` to `shell.execute().result()`. This release's `dsh` depends on cordis `^4.0.3`, and a probe must pin cordis to that version — two copies of `@deepseek-ai/dsh-tools` make the tool scheduler's Symbol miss, and tool calls die on the first step. The development pin remains `0.1.5-rc.2`.

### Fixed

- **An open session on `0.1.6-alpha.2` was shown as "No active session"** in the Workspace Folders panel. That release dropped `current` from the Session list snapshot; the session on screen is the catalog row whose `retainedBy.mainView` is positive, because the main view retains it with source `mainView`. `src/compat/client-session.ts` probes both shapes structurally. A populated catalog with nobody retained still shows the empty state and never falls back to `ids[0]`.

## [0.1.1] - 2026-09-16

The **hardening batch (H1–H4)** after `v0.1.0`: no new user-facing features, but four boundary gaps closed — cross-process authority, panel authority, upstream compatibility, and additional-root instructions. The reasoning lives in [ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md), [ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md), [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md), and [ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md).

### Upgrade Notes (Breaking Changes)

- **The first `dsh plugin add` fails once, from every install source**: this release introduces the native dependency `koffi` (the FFI wrapper behind Registry Authority on Windows), and pnpm ≥10 runs no dependency build script by default, so the first `add` exits with `[ERR_PNPM_IGNORED_BUILDS]` and the plugin never reaches `dsh.profile.bundles`. `dsh` leaves the pending decision in that profile's `pnpm-workspace.yaml` (`koffi: set this to true or false`); set it to `true` and run `add` again. The npm and tarball sources had no such step in `v0.1.0`. See [Troubleshooting: the install stops at build approval](./docs/troubleshooting/install-stops-at-build-approval.md).
- **The supported upstream runtimes narrow to the exact list `0.1.5-rc.2`, `0.1.6-alpha.1`** (they used to be the range `>=0.1.2-alpha.4 <0.2.0`). When the host release is neither of those, or several `@deepseek-ai/dsh-*` packages are mixed across versions, the `fs` / `sandbox` / `registry` / `instructions` rows **do not start**: the composition degrades to "this plugin is not installed" and prints an explanation at startup. The reason is that this plugin replaces the fence itself and works by recognizing argv shapes measured on specific upstream releases, so a semver range is a promise about versions nobody verified ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)). The diagnosis steps are in [Troubleshooting: a DSH release outside the support matrix](./docs/troubleshooting/unsupported-dsh-release.md). **If you are still on the `0.1.2-rc.1` runtime that `v0.1.0` was measured against (for example a runtime bundled with an installed desktop app), upgrade that runtime first — otherwise this release has no effect.**
- **The panel no longer accepts a client-named root**: every panel endpoint requires `sessionId`, and the primary root comes only from the host-side `session.header.cwd`. The client `primaryRoot` field and the `sandboxPolicy` fallback are gone. When the browser has no active session, the panel shows "No active session" and does not call the host at all ([ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md)).

### Added

- **Cross-process Registry Authority (H1)**: at most one DSH process may hold the root registry per `$DSH_HOME` (POSIX `flock` / Windows named semaphore, released by the kernel when the process exits or crashes). A contending process fails closed — it publishes an empty scope and registry mutations report `registry-contended`; once the holder exits, `/workspace-folders list` or a panel refresh takes over through `refresh()` ([ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md)).
- **An additional root's own instruction files now reach the model (H4)**: the root's **top-level** `AGENTS.md` / `CLAUDE.md` are injected before the first step of a session; instruction files in the subdirectories the session has **successfully** touched with `read` / `write` / `edit` (including every ancestor directory of a touched file, up to the additional root) are injected incrementally as those directories come up for examination; a changed file is re-sent on its own, and a file or root that disappears is **explicitly withdrawn**. All additional roots share a 64 KiB budget, and delivery is a `user`-role `{ kind: 'plugin', form: 'instructions' }` message (never `systemPrompt`). Upstream discovery walks upward from the session cwd and can never reach an additional root — that is why this exists ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- **Support for a second upstream runtime, `0.1.6-alpha.1`**, alongside the `0.1.5-rc.2` baseline; both have run the full matrix (the sync/async shape of `confine`, the renamed instruction renderer, and the two LLM wire protocols are absorbed by the adapter layer and the smoke scripts).
- **`pnpm compat:check`**: a consistency gate over the allowlist / `peerDependencies` / development pin / installed tree, run as the first CI step.
- **The `multi-root-compat` startup gate row**: the version verdict became a precondition for the other security-relevant rows instead of a log line.
- **A weekly upgrade lane** (`upgrade.yml`): it re-points the pin at the newest upstream pre-release and runs the full matrix, with read-only permissions, no commits, and no automatic widening of the allowlist.
- Two troubleshooting entries: [a DSH release outside the support matrix](./docs/troubleshooting/unsupported-dsh-release.md) and [the registry owned by another process](./docs/troubleshooting/registry-owned-by-another-process.md).

### Changed

- Version differences are concentrated in the `src/compat/` adapter layer and decided by **structural probes** (is the return value thenable? which export name exists?) rather than by comparing version strings; business code contains no version checks at all.
- The two optional peers (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent-instructions`) are now **loaded on demand**: the barrel's load-time dependency set equals the required-package set, so a minimal composition that never builds a message cannot fail while loading.
- `pnpm verify:all` deliberately **excludes** `compat:check` (the upgrade lane must run the full matrix on a candidate that is not on the allowlist yet); the main CI lane runs it separately, first.
- New `./compat` and `./instructions` subpath exports.
- Installation and release: the `prepare` script is now self-contained (git installs build on the spot through pnpm, after the user authorizes `allowBuilds`); the README documents all four installation sources (npm / tarball / local path / GitHub); npm publishing moved to **trusted publishing (OIDC)**, so the repository stores no npm credential at all.

### Fixed

- **Authority teardown order**: the old code released the kernel lease *before* closing the domain, so a successor process could acquire the lease and open a snapshot missing this process's last write. The whole teardown now runs inside the store-wide authority transition queue as "drain in-flight mutations → close the domain → release the lease", and sets `disposed` to refuse later acquisitions (`tests/registry-lease.spec.ts`).
- **Instruction delivery state is committed from the actual artifact**: a renderer that omits or truncates a file no longer records a full digest; a message that fails to build or is cancelled is no longer treated as delivered; a spent budget still runs withdrawals, so cross-root withdrawals and deferred touches are no longer skipped.
- **Instruction files in intermediate directories** of an additional root could never reach the model (only the touched file's parent directory was examined); every ancestor directory is now examined.
- **`DSH_MULTI_ROOT_COMPAT=warn` tightened**: it relaxes `unsupported` only (a consistent tree the allowlist does not name yet — exactly what the upgrade lane probes). `mixed` / `incomplete` are rejected in both modes.
- **"Package absent" is separated from "installed but failed to evaluate"**: the latter is no longer cached as an absence, so the process cannot silently stop delivering additional-root instructions.
- **Windows lock naming is normalized by physical path**: two processes reaching one store through a path alias (junction / symlink) used to hash different names and could both become the authority.
- **Session event pairing is scoped per session**: the same `tool/call` id in two sessions no longer overwrites the other session's pending call.
- **Shell input handling in the upgrade workflow**: the manual version and the candidate version travel through step `env` and are validated as a single line instead of being interpolated into `run`.
- **A local pack no longer carries earlier builds**: `lib/` is stripped of the previous build's JavaScript before `bundle` runs (tsdown's shared chunks are content-hashed, so an old name never disappears on its own). The tarball `pnpm pack` produces now contains exactly one build's artifacts instead of shipping historical chunks as dead code (`files` publishes every `lib/*.js`).

## [0.1.0] - 2026-09-13

The first release: the three MVP milestones (M1–M3).

### Added

- **Plugin skeleton and composition (M1)**: a bundle patch replaces the upstream `fs-sandbox` and `sandbox` provider rows and inserts the plugin's rows (`bash-sandbox` stays upstream — all bash and PTY confinement goes through `ctx.sandbox`). With no additional root configured, behavior is item-for-item identical to an uninstalled harness; the three structural risks (composition, disable/insert ordering, duplicate provides) are pinned by differential tests.
- **Multi-root capability (M2)**: `ctx.multiRootScope` (the single grant source), `MultiRootFileSystem` (the in-process containment fence, subclassing upstream's `LocalFileSystem`, which has no fence of its own), and `MultiRootSandboxProvider` (cloning the upstream grant spelling onto Seatbelt / bwrap / Landlock profiles for the additional roots). The fs side and bash/PTY share one scope; security does not degrade.
- **A model-visible topology snapshot**: emitted through `systemPrompt.context` only under `workspace-write` with a non-empty root set (same workspace, cwd unchanged); empty-root and read-only output stays byte-identical.
- **The root registry (M3)**: persisted in the `multi_root_workspace` storage domain keyed by the canonical primary root, validated on every write and every read; each record carries a `recordedPath`, and **re-resolving a path is not re-authorizing it** — a directory replaced by a symlink pointing elsewhere is marked `redirected` and stops being granted.
- **The `/workspace-folders` command**: `list` / `add <path>` (with no argument it opens the system directory picker) / `alias` / `remove` / `reveal`, all usable in headless compositions too.
- **The Workspace Folders browser panel**: a sidebar-foot action plus a self-drawn dialog talking to the host over the plugin's own Connection RPC channel; bilingual copy following the UI language, with every color taken from the host's `var(--dsw-*)` design tokens.
- **A cross-repository journey e2e** (`pnpm smoke:journey`): it drives a real agent turn in both the `web` and `headless` compositions across two Git repositories (primary root `repo-a`, additional root `repo-b`) and asserts that writes outside the roots are refused. No model credentials are needed (the model endpoint is scripted).
- **Installation sources**: npm registry / tarball / local path / GitHub; a tag-triggered `release.yml` runs verify → npm publish (with provenance) → GitHub Release.
- **Platform scope**: full kernel-level multi-root on macOS (Seatbelt) and Linux (bwrap / Landlock); Windows covers the `fs` write path, while multi-root for confined bash/PTY is out of scope for this phase (a one-time explicit warning is printed when the scope is non-empty).

### Fixed

- All eight findings of the pre-release external review (three of them release-blocking) are fixed, each with a regression test: a registered directory replaced by a symlink transplanting its authority (which introduced `recordedPath` — **re-resolving a path is not re-authorizing it**), concurrent registry mutations losing a write or reviving a revoked grant (per-primary-root mutations are serialized), a refresh not re-checking directories, a typed path being overwritten by the directory picker, the `reveal` response contract and failure code, duplicate ids not validated, the primary root missing from nesting validation, and CI testing before building.

[Unreleased]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/tag/v0.1.0
