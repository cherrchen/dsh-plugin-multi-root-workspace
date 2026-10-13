# User Guide

中文：[README.md](./README.md)

The user-facing guide: the top-level README covers the "how"; this guide fills in the "why" and the exact semantics, for the moments the defaults don't cover.

## Contents

- [Why the supported matrix is an exact list](#why-the-supported-matrix-is-an-exact-list)
- [What the allowBuilds step authorizes](#what-the-allowbuilds-step-authorizes)
- [Differences between install sources](#differences-between-install-sources)
- [The full semantics of `/workspace-folders`](#the-full-semantics-of-workspace-folders)
- [Access levels, the root limit, and per-tool caps](#access-levels-the-root-limit-and-per-tool-caps)
- [What the composition actually does](#what-the-composition-actually-does)
- [Model-side and panel-side behavior](#model-side-and-panel-side-behavior)

## Why the supported matrix is an exact list

This plugin replaces `ctx.fs` and `ctx.sandbox` — the security boundary itself — and it recognizes kernel sandbox dialects from argv shapes measured against specific upstream releases. So `peerDependencies` names only the releases that have actually been through the full verification, and startup checks again: if the host's release is not on the list, or several `@deepseek-ai/dsh-*` packages disagree about which release they are, the fs / sandbox / registry / instructions / lsp / workspace-files rows **do not start**, the composition degrades to "this plugin is not installed", and one explanatory line is logged. To diagnose, see [troubleshooting](../troubleshooting/unsupported-dsh-release.md); for the reasoning, [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md).

## What the allowBuilds step authorizes

The plugin carries a native dependency that must be built, `koffi` (the FFI wrapper behind Registry Authority on Windows; installed but unused elsewhere), and pnpm ≥10 runs no dependency lifecycle script by default. So the first `dsh plugin add` fails with `[ERR_PNPM_IGNORED_BUILDS]` and leaves the pending decision in that profile's `pnpm-workspace.yaml`. Writing `koffi: true` under `allowBuilds` means **letting that dependency's install script run on your machine** (outside any sandbox the agent runs in) — `koffi`'s script only precompiles locally.

Two observed caveats (DSH `0.2.1-alpha.2`, tarball source): the profile's `pnpm-workspace.yaml` may carry **no** `set this to true or false` marker (just add `allowBuilds` yourself), and the recovered `add` may exit 0 without activating the plugin into `dsh.profile.bundles` — check the profile's `package.json`, and if the bundle is missing run `remove` + `add` once. Diagnosis steps: [troubleshooting](../troubleshooting/install-stops-at-build-approval.md).

## Differences between install sources

- **npm / tarball**: pre-built artifacts — the plugin itself is never compiled; the first install needs `allowBuilds`.
- **GitHub**: delivers source code, built automatically during `add` by the package's own `prepare` script (a direct transpile of `src/`, no type-checking), so `allowBuilds` has to cover two entries, this package itself and `koffi`. With no ref the install tracks the head of `main`; a version ref like `#v0.1.6` pins the content, and a semver range like `#semver:*` always resolves to the latest tag.
- **From source**: pnpm `link:` to a local checkout whose dependencies are already installed in this repository — no `allowBuilds` needed; run `pnpm build` first to produce `lib/` (not tracked by Git).

When running DSH from a source checkout, `dsh` is not on PATH — use `pnpm dsh` in the commands instead.

## The full semantics of `/workspace-folders`

The command is the text entry point and works in headless compositions too. Subcommands: `list` / `add` / `remove` / `alias` / `access` / `reveal` / `help`; a bare `/workspace-folders` is `list`.

- `add` with no path opens the OS directory picker (where the composition provides one); `add --read-only` with no path works too.
- Paths may be quoted, and `~` expands to the home directory; registration canonicalizes first — a path that duplicates an existing root, nests inside one, or is the workspace root itself is rejected.
- `remove` / `access` / `alias` / `reveal` take `<n|path>` (n is the number `list` prints).
- `alias` with no name clears the existing alias.
- `access` accepts `inherit`, `read-only`, or `read-write`; changes that widen access require an available root. See [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) for the transition rules.
- `list` reports each root's state honestly: roots shown as `missing` (absent right now) or `redirected` (replaced by a symlink pointing elsewhere) **stay registered but are not granted**; once the directory is back, one `list` or a panel refresh grants it again — no restart.
- The command's own output is in English (the host side has no active locale information).

## Access levels, the root limit, and per-tool caps

The panel shows both the registration policy and host-derived effective session access, with tool write caps. Switching between inherit and fixed read-write requires confirmation. A missing registration loses its grant while retaining its read-only boundary.

On the B9 development branch, new roots default to `inherit` (the session mode); `add --inherit|--read-only|--read-write` and the panel select among three policies. Explicit read-only keeps full membership but denies writes even under Full-access; fixed read-write allows writes to that root even in a globally read-only session. Old writable records migrate to inherit, and re-registration preserves the existing policy. [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) owns the access and migration contract. Running processes retain their startup snapshot; changes affect later calls and new processes. See the [roadmap](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13) for whether a released package contains B9.

The Windows ambient deny runner remains under development: ordinary processes lack SeTcbPrivilege for provisioning security attributes. Complete execution requires a privileged-broker scope decision and native acceptance; current launches fail closed and do not count as implemented support. The target still reports partial enforcement. Its ACL prerequisites, parent guards, and standing ACE boundaries are documented in [ADR-0019](../decisions/ADR-0019-windows-token-attributes-and-conditional-acls.md). Unsupported backend combinations refuse to start rather than launch a bare process; ADR-0017 documents those limits.

Each primary root caps its additional roots (default 16, configurable up to 64 via the registry row's `maxAdditionalRoots`); new adds beyond the limit are refused while roots already stored stay granted ([ADR-0014](../decisions/ADR-0014-root-limit-and-provider-conflict.md)).

A host may also set `toolAccess: { <tool>: 'read-only' }` on the `multi-root-scope` row so a given tool can never write any additional root (e.g. `{ bash: 'read-only' }` — bash can still write the primary root); an invalid configuration fails closed.

## What the composition actually does

`dsh --profile web --dump-config` prints a YAML array of rows grouped by bundle (each row has `id` / `name` / optional `disabled` / `config`); `# == <bundle>` comment lines mark the source bundle and `patched by` marks a patch. Installing this plugin changes exactly two things:

- the upstream `fs-sandbox` and `sandbox` rows gain `disabled: true`;
- a `# == @dsh-electron/dsh-plugin-multi-root-workspace` section is appended with all the `multi-root-*` rows (the compat gate, fs, sandbox, the providers-conflict check, scope, registry, instructions, lsp, workspace-files, process-fence, command, and the client carrier row).

`bash-sandbox` stays upstream: confined modes use `ctx.sandbox`; `multi-root-process-fence` wraps the public shell, PTC, and PTY entries to apply the same scope restrictions to the Full-access bypass. The plugin is an out-of-tree extension and modifies no upstream package.

## Model-side and panel-side behavior

- The additional-root topology reaches the model through a `systemPrompt.context` contribution in the system prompt (re-rendered when grants change); the session origin stays the same and changing the execution directory does not change grants. No introspection tool is needed.
- An additional root's own `AGENTS.md` / `CLAUDE.md` also reaches the model: the top-level file is injected before the session's first step, and a subdirectory's is injected once the session has successfully worked in that directory (upstream's native discovery walks upward from the session cwd and can never reach an additional root).
- On the panel side: the **Folders** action at the sidebar foot opens the dialog, and the Files tab's root switcher can browse additional roots (a faithful fork of the native tree takes over while one is selected; switching back to the primary root restores the native view). The panel's copy is bilingual and follows the interface language.
