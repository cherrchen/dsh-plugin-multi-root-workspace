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
- **GitHub**: delivers source code, built automatically during `add` by the package's own `prepare` script (a direct transpile of `src/`, no type-checking), so `allowBuilds` has to cover two entries, this package itself and `koffi`. With no ref the install tracks the head of `main`; a version ref like `#v0.1.12` pins the content, and a semver range like `#semver:*` always resolves to the latest tag.
- **From source**: pnpm `link:` to a local checkout whose dependencies are already installed in this repository — no `allowBuilds` needed; run `pnpm build` first to produce `lib/` (not tracked by Git).

When running DSH from a source checkout, `dsh` is not on PATH — use `pnpm dsh` in the commands instead.

## The full semantics of `/workspace-folders`

The command is the text entry point and works in headless compositions too. Subcommands: `list` / `add` / `remove` / `alias` / `access` / `reveal` / `isolate-profiles` / `help`; a bare `/workspace-folders` is `list`.

- `add` with no path opens the OS directory picker (where the composition provides one); `add --read-only` with no path works too.
- Paths may be quoted, and `~` expands to the home directory; registration canonicalizes first — a path that duplicates an existing root, nests inside one, or is the workspace root itself is rejected.
- `remove` / `access` / `alias` / `reveal` take `<n|path>` (n is the number `list` prints).
- `alias` with no name clears the existing alias.
- `access` accepts `inherit`, `read-only`, or `read-write`; changes that widen access require an available root. See [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) for the transition rules.
- `list` reports each root's state honestly: roots shown as `missing` (absent right now) or `redirected` (replaced by a symlink pointing elsewhere) **stay registered but are not granted**; once the directory is back, one `list` or a panel refresh grants it again — no restart.
- `isolate-profiles` is a host-side maintenance command (the panel has no endpoint for it): by default it performs a **read-only inspection** — listing each confirmed profile under `$DSH_HOME/profiles/` with its `packageImportMethod` state and scanning the whole home once, reporting `scanned N dirs/M files, K multi-link files, J uninspectable`; when anything cannot be inspected the verdict is INCOMPLETE and must not be read as clean. `--apply` atomically writes `packageImportMethod: copy` into each fixable profile's `pnpm-workspace.yaml` (creating the file when absent, replacing scalar values in place while preserving comments and line endings, and refusing to rewrite complex, conflicting, or unreadable files). On Windows a deny ACE lands on the file object rather than a link name — when profile dependencies arrive as hardlinks (the pnpm default), denying under `$DSH_HOME` would rewrite shared objects in the global store; this command is the remediation the restricted Full-access preflight refusal points at. It only edits configuration: **existing hardlinks remain hardlinks until you quit the host, delete the profile's `node_modules`, and reinstall from the lockfile as the report instructs**; it does not repair Administrators-owned paths or deny ACEs already written to the store or other projects, and it performs no global ACL reset. The command does not delete `node_modules` or run pnpm for you, and a profile created afterwards needs the same configuration or another inspection.
- The command's own output is in English (the host side has no active locale information).

## Access levels, the root limit, and per-tool caps

The panel shows both the registration policy and host-derived effective session access, with tool write caps. Switching between inherit and fixed read-write requires confirmation. A missing registration loses its grant while retaining its read-only boundary. When two registrations' granted directories overlap — including the recorded boundary of a missing one — both memberships are withheld, yet each recorded deny boundary still holds and reordering the list cannot lift it; removing one of the registrations resolves the conflict.

When two DSH processes share the same storage root, only the process holding the registry lease can read the registry. The other process's empty root table does not mean "no restrictions": until it takes the lease over or the store recovers, both Full-access and workspace-write grant writes only to the primary root, with no shared platform temp grants. Read-only still refuses writes, and explicit denies take precedence over the primary grant.

On the B9 development branch, new roots default to `inherit` (the session mode); `add --inherit|--read-only|--read-write` and the panel select among three policies. Explicit read-only keeps full membership but denies writes even under Full-access; fixed read-write allows writes to that root even in a globally read-only session. Old writable records migrate to inherit, and re-registration preserves the existing policy. [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) owns the access and migration contract. A running process or a persistent terminal keeps the deny set it was started with — a terminal opened before a root turned read-only stays unrestricted until restarted — so changes constrain only later calls and newly started processes. See the [roadmap](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13) for whether a released package contains B9.

Two boundaries are worth knowing on their own. **A restricted Full-access also protects the whole `$DSH_HOME`**: whenever any deny boundary exists (a registered read-only root, a tool-capped member, or an unavailable registry authority), the home directory (`~/.dsh` or `DSH_HOME`) joins the deny set — the durable store, the registry lease and user profiles live there and an ambient process must not touch them; zero additional roots with a healthy authority keep Full-access byte-identical to upstream. When the primary root sits inside `$DSH_HOME` the deny wins, and the workspace is unwritable under Full-access. **Your panel terminal is never confined by this plugin**: the process fence prefixes only PTY spawns whose env carries `DSH_PTY_SESSION_ID` (stamped by the terminal-bash backend for agent PTYs); the panel's terminals carry no such marker — they are user behavior and pass through in every mode. The marker is a startup compatibility assertion, not an assumption: an installed `dsh-terminal-bash` that no longer carries the constant refuses plugin load, so a new backend can never let agent PTYs masquerade as user terminals.

The Windows ambient deny runner uses an administrator-installed broker to assign normal deny-only group tokens to suspended children, then resumes only after native readback verification. A missing or untrusted broker refuses launch. Windows ACL still reports partial; [ADR-0020](../decisions/ADR-0020-windows-normal-deny-groups.md) owns its token and ACL contract. Unsupported backend combinations refuse launch instead of falling back to unconfined execution; see ADR-0017 for backend limits.

Each primary root caps its additional roots (default 16, configurable up to 64 via the registry row's `maxAdditionalRoots`); new adds beyond the limit are refused while roots already stored retain their registration grants. Windows Full-access launches have a separate bounded deny-set capacity and refuse the whole launch beyond that budget; see [ADR-0020](../decisions/ADR-0020-windows-normal-deny-groups.md#协议容量与安装回滚修订2026-10-15) ([ADR-0014](../decisions/ADR-0014-root-limit-and-provider-conflict.md)).

A host may also set `toolAccess: { <tool>: 'read-only' }` on the `multi-root-scope` row so a given tool can never write any additional root (e.g. `{ bash: 'read-only' }` — bash can still write the primary root); an invalid configuration fails closed.

## What the composition actually does

`dsh --profile web --dump-config` prints a YAML array of rows grouped by bundle (each row has `id` / `name` / optional `disabled` / `config`); `# == <bundle>` comment lines mark the source bundle and `patched by` marks a patch. Installing this plugin changes exactly two things:

- the upstream `fs-sandbox` and `sandbox` rows gain `disabled: true`;
- a `# == @dsh-electron/dsh-plugin-multi-root-workspace` section is appended with all the `multi-root-*` rows (the compat gate, fs, sandbox, the providers-conflict check, scope, registry, instructions, lsp, workspace-files, process-fence, command, and the client carrier row).

`bash-sandbox` stays upstream: confined modes use `ctx.sandbox`; `multi-root-process-fence` wraps the public shell, PTC, and PTY entries to apply the same scope restrictions to the Full-access bypass. The plugin is an out-of-tree extension and modifies no upstream package.

## Model-side and panel-side behavior

- The additional-root topology reaches the model through a `systemPrompt.context` contribution in the system prompt (re-rendered when grants change); the session origin stays the same and changing the execution directory does not change grants. No introspection tool is needed.
- An additional root's own `AGENTS.md` / `CLAUDE.md` also reaches the model: the top-level file is injected before the session's first step, and a subdirectory's is injected once the session has successfully worked in that directory (upstream's native discovery walks upward from the session cwd and can never reach an additional root).
- On the panel side: the dialog labels the primary root as “Primary working directory” and places a “Current Agent working directory” tag beside the matching root name. A subdirectory matches its nearest listed ancestor; an unmatched cwd produces no tag. “Workspace Write” and “Read Only” use the upstream permission menu’s icons and labels for fixed read-write and fixed read-only access; “Inherit” follows session permissions. The plugin management page uses the upstream Switch for the global additional-root Skills setting, preserving each folder’s choice. Folder rows omit the Skill namespace. A document-and-star icon in the right-hand action row toggles that folder’s skills: shown in full when enabled and crossed out when disabled, with a background only on hover or press and a tooltip explaining the state and next action. While saving, the panel preserves button appearance and focus while blocking repeated actions. Skill state updates only after the host confirms the save; a failed save retains the previous state and displays an error. The **Folders** action at the sidebar foot opens the dialog, and the Files tab's root switcher can browse additional roots (a faithful fork of the native tree takes over while one is selected; switching back to the primary root restores the native view). The panel's copy is bilingual and follows the interface language.

B9 selective read-only under Windows Full-access requires the administrator-installed privileged broker shipped with the package ([installation and security boundary](../decisions/ADR-0020-windows-normal-deny-groups.md#安装与卸载)); the plugin does not elevate itself. When the child is a Store/MSIX application (such as `pwsh.exe` under the WindowsApps alias) the combination refuses to launch with a diagnostic — a packaged process carries a package identity the minted deny token cannot preserve; install the MSI or ZIP build of PowerShell (or use another non-packaged executable) and put it ahead of the WindowsApps alias on PATH. After upgrading the plugin, reinstall the broker once with `install.ps1` so the new caller rule takes effect. On Linux the same combination requires usable bubblewrap, even when ordinary confined execution selects Landlock: on a host where upstream chose Landlock — meaning bwrap was already unusable (not installed, or unprivileged user namespaces disabled) — a Full-access command that carries any deny boundary (an explicit read-only root, or the `$DSH_HOME` a restricted Full-access protects) fails closed at launch; install and enable bwrap for that combination, or avoid explicit read-only roots under Full-access on such hosts. Missing dependencies are runner failures and never authorize an unconfined launch.
