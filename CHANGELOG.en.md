# Changelog

This file records the user-visible changes of every **released** version.

中文：[CHANGELOG.md](./CHANGELOG.md)

- The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
- For installation sources, the supported upstream runtimes, and known limitations, see the [README](./README.en.md).
- The evidence, numbering, and release state of each version live in the [roadmap progress ledger](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账). The body of each GitHub Release is generated from the commit history by `scripts/release-notes.mjs` and is the complete raw list behind this file.

## [Unreleased]

Nothing yet.

## [0.1.1] - 2026-09-16

The **hardening batch (H1–H4)** after `v0.1.0`: no new user-facing features, but four boundary gaps closed — cross-process authority, panel authority, upstream compatibility, and additional-root instructions. The reasoning lives in [ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md), [ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md), [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md), and [ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md).

### Upgrade Notes (Breaking Changes)

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

[Unreleased]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/tag/v0.1.0
