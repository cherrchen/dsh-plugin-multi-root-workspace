# The DSH compatibility contract: what an Agent needs to know first

中文：[dsh-compat-contract.md](./dsh-compat-contract.md)

This note records the compatibility machinery you must understand **before changing this repository**, because it is easy to trip over. The reasoning lives in [ADR-0009](../../docs/decisions/ADR-0009-dsh-compat-contract.md) and the operator-facing diagnosis in [the troubleshooting entry](../../docs/troubleshooting/unsupported-dsh-release.md). This note only covers what you, as an Agent, will run into.

## 1. One source of truth for the support matrix

```text
src/compat/dsh-version.ts  →  SUPPORTED_DSH_RELEASES
```

It is an array of **exact versions**, not a semver range. Currently:

```ts
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'] as const
```

When you change it, these four must agree or `pnpm compat:check` fails:

```text
src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   the allowlist
package.json                peerDependencies         "0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2 || 0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5 || 0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5 || 0.2.2-alpha.2 || 0.2.2-alpha.3 || 0.2.2-rc.1 || 0.2.2-rc.2"
package.json                devDependencies          one entry of the allowlist (currently 0.2.2-rc.3)
node_modules                resolved versions        one entry of the allowlist
```

`scripts/check-dsh-compat.mjs` reads that array out of the TypeScript source as **text**, not by importing it. So: **do not rewrite it into anything other than an `export const NAME = [...]` literal** (assembled from elsewhere, wrapped in an expression other than the type assertion, and so on) — the static checker throws outright. The reason is that this check must run before `pnpm build`, on a clean checkout with no `lib/`.

Shared upstream packages that are not `dsh-*` (`cordis`, `schemastery`, `node-addon-system`) are **peers only** for the same reason: they are singletons the host tree already carries — `dsh-sandbox-local` depends on the latter two directly on every supported release, so a copy shipped by this plugin is always a second one. What a `dependencies` entry actually did (issue #30): the profile ended up with schemastery `3.18.5` against the host's `3.18.6-alpha.1`, cosmokit `1.8.6` against `1.8.7-alpha.1`, and a redundant same-version node-addon-system — the launcher's dependency self-check reported `profile-core-mixed` / `profile-core-copy`. The mechanism to remember: a range like `^3.18.2` does **not** match a prerelease (`3.18.6-alpha.1` fails it), so the peer range must spell a stable-line range plus each alpha line by name, the same shape the cordis peer uses (`>=3.18.2 <4.0.0 || 3.18.5-alpha.1 || 3.18.5-alpha.2 || 3.18.6-alpha.1 || 3.18.6-alpha.2`); extend the union when a promotion pulls in a new alpha line. `devDependencies` pins the exact version the pinned host ships, repointed by `upgrade-dsh.mjs` through ecosystemPins. `compat:check` and `tests/compat.spec.ts` hard-fail when any `@deepseek-ai/*` name appears under `dependencies` / `optionalDependencies`.

The same singleton rule applies to **native images**: `koffi` stays a legitimate `dependencies` entry (the fallback for standalone contexts), but inside an installed profile it must dlopen the host's copy — `dsh plugin add` plants a private koffi next to the one the host already loaded, and two `koffi.node` images in one process SIGBUS under darwin-arm64 pointer authentication, exiting without any output (packed smoke, 2026-11-01; main crashes identically — a pre-existing F4 regression). FFI call sites use `loadHostKoffi()` in `src/compat/koffi.ts`. Worktree's synchronous Git metadata reads use `loadHostKoffiSync()` from the same module. Both anchor at `dsh-fs-local`, a required peer that carries koffi on every supported release, and fall back to the package-local copy only when the host tree cannot be resolved. `tests/compat.spec.ts` scans `src/` and rejects any bare `import('koffi')` outside `compat/koffi.ts`.

## 2. Your tests may fail because of the gate — and that is correct

`multi-root-compat` is the first row in the patch, and these **widened-authority** rows inject it:

```text
multi-root-providers
multi-root-registry
multi-root-instructions
multi-root-lsp
multi-root-workspace-files
multi-root-process-fence
```

Cordis will not start a row whose injected service is absent. So before mounting any of those rows in a test (or a transitively gated row such as `multi-root-command`, which injects `multiRootRegistry`), you must first:

```ts
import { mountCompat } from './support/compat.ts'

await mountCompat(ctx)
```

Otherwise `ctx.get('multiRootRegistry')` and friends are `undefined`. That is not a bug; it is the gate working (`tests/compat.spec.ts` asserts this explicitly).

**The two provider rows (`multi-root-fs` / `multi-root-sandbox`) deliberately do NOT inject the gate**: their widening is scope-driven, and the gated registry can never populate the scope on a refused installation, so they degenerate to the upstream providers. This must hold: the patch already disables upstream `fs-sandbox` / `sandbox` unconditionally, so an absent provider takes `ctx.fs` / `ctx.sandbox` down → `ctx.shell` (injects `sandbox`) never starts → `permissionPresets` (injects `shell`) never starts → the whole profile bricks (`permissionPresets/catalog` reports service-unavailable). The correct shape of a refused gate is "plugin features absent, profile intact" — never "profile dead".

`mountCompat` mounts the **real** compat row, gate policy included. So the whole unit suite fails outright on a release that is not on the allowlist — deliberately; see point 5.

## 3. `confine` is synchronous on one release and asynchronous on another

```text
0.1.5-rc.2     confine(argv, policy): ConfinedArgv
0.1.6-alpha.1  confine(argv, policy, signal?): Promise<ConfinedArgv>
0.1.6-alpha.2  same `confine` shape as 0.1.6-alpha.1 (measured 2026-09-22). The session catalog is a different shape; see the next section.
0.1.7-alpha.1  same `confine` shape as 0.1.6-alpha.1 (measured 2026-09-22; other shapes on this release did change, see §4)
0.1.7-alpha.2  same shape as 0.1.7-alpha.1 (measured 2026-09-24)
0.1.7-rc.1     same shape as 0.1.7-alpha.1 (measured 2026-09-24). This release adds an install-time peer gate; see the end of §4
0.1.7-rc.2     same shape as 0.1.7-rc.1 (measured 2026-09-25 against the tags). cordis stays `~4.0.4`
```

**Do not** hand-write a signature in `src/sandbox.ts` that suits one release. Go through `widenConfined()` in `src/compat/sandbox-confine.ts`, which **preserves the shape**: a synchronous base result stays synchronous, a promise stays a promise.

Never "just wrap everything in a promise". On `0.1.5-rc.2` that would turn `ctx.sandbox.confine()` into a thenable for every caller in the composition — the bash executor, the PTY backend — which means the plugin introducing a breaking change of its own.

When reading the result in tests and smokes:

- unit tests use `confined(provider, argv, policy)` from `tests/support/confine.ts`;
- smoke scripts always `await ctx.sandbox.confine(...)`.

**This is a quiet trap**: awaiting a plain value is a no-op, but reading `.argv` off a promise yields `undefined`, and the resulting `Cannot read properties of undefined (reading 'some')` looks nothing like a version problem.

## 4. Upstream API changes may only branch inside `src/compat/`, and only structurally

Business code contains no version checks. The adapters today:

| File | Difference it absorbs |
| --- | --- |
| `src/compat/sandbox-confine.ts` | `confine`'s sync/async shape and arity |
| `src/compat/agent-instructions.ts` | the renderer rename: `renderWorkspaceContext` (0.1.5) → `renderAgentInstructions` (0.1.6; unchanged on 0.1.7) |
| `src/compat/client-session.ts` | current session: `list.current` (0.1.5 / 0.1.6-alpha.1) → catalog row `retainedBy.mainView > 0` (0.1.6-alpha.2 and 0.1.7-alpha.1 through 0.1.7-rc.2; 0.1.7 moved other catalog fields, not this predicate) |
| `src/compat/llm-message.ts` | through session format 3, emit `{ kind: 'plugin', plugin, form: 'instructions' }`; format 4 (`SESSION_FORMAT_VERSION` on `0.1.7`) rejects `kind: 'plugin'` and the adapter emits `{ kind: 'multi-root-workspace', plugin, form: 'instructions' }`. Probe the format constant the session package exports, **not** the renderer name — 0.1.6 already renamed the renderer and still accepts `plugin`. Do not use `agent-instructions`: upstream treats that kind's `changes` array as its own reconciliation authority |
| `src/compat/tool-result.ts` | the failure bit is `content[0].isError` on 0.1.5/0.1.6 and `isError` on the message itself on 0.1.7. `event.data.error` still exists on both |
| `src/compat/client-icons.ts` | panel icons: pixel names on 0.1.5/0.1.6 (`IconFolderClose16`), weight names on 0.1.7. Upstream UI uses Regular, not Medium. Prefer the pixel name, then Regular. Decorative glyphs go through `maybeIcon` — a soft probe that degrades to no icon instead of throwing; the permission glyphs `IconWorkspaceWrite`/`IconReadOnly` exist only on 0.1.7+ |
| `src/compat/process-entrypoints.ts` | which public entries the process fence wraps: a presence probe for `execute`/`run`/`start` on `ctx.shell` (`start` existed through 0.1.6); `ctx.ptcRuntime` is probed for the public `run` only (the concrete runtime's `execute` helper is private and never a cross-package seam) |
| `scripts/lib/profile-boot.mjs` | call `healProfilesModuleFallback` when it is a function; otherwise `createRuntimeResolution`, then `hostCtx.plugin(PluginPackages, { resolution })` inside `boot`'s prepare. 0.1.7 no longer exports heal |
| `scripts/lib/shell-exec.mjs` | use `shell.run` when it exists; otherwise `shell.execute(spec)` then `execution.result()`. 0.1.7 renamed `SandboxBashExecutor.run` to `execute` |

Always probe **structurally** (is the value a thenable, which export name exists, does the snapshot carry `current`) rather than comparing version strings. Upstream is pre-stable and reshapes things within a release; a structural probe copes with that, a version comparison does not.

`0.1.7-alpha.2`, `0.1.7-rc.1`, and `0.1.7-rc.2` keep every shape in the table above relative to `0.1.7-alpha.1` (measured 2026-09-24 against `alpha.1` / `alpha.2` / `rc.1`, and 2026-09-25 against `rc.1` → `rc.2`). `rc.1` adds an **install-time** gate that does not live in `src/compat/`: `dsh plugin add` and `loadProfile` run `semver.satisfies(runtime, peerRange, { includePrerelease: true })` on every `@deepseek-ai/dsh*` peer, and refuse the install or skip the bundle when it fails. Promoting a `0.1.7-rc.1`-or-later release therefore has to widen `peerDependencies` in the same change, or the smoke's `dsh plugin add` fails before this plugin's runtime gate runs. `DSH_MULTI_ROOT_COMPAT=warn` does not relax that gate.

**This is a quiet trap**: `0.1.6-alpha.2`'s host matrix (`confine`, the instruction renderer, the journey Messages endpoint) matches alpha.1, so it was promoted with "no adapter change". The client Session Controller still dropped `SessionListState.current` in `6830e1460d` and moved navigation onto the main view's `retain(..., { source: 'mainView' })`. A panel that still reads `list.current` then shows "No active session" for an open conversation and **does not call the host**.

Probe order: a non-empty `current` wins (the old shape), otherwise the first catalog row whose `retainedBy.mainView` is a positive number. A populated catalog with nobody retained returns `undefined` — **never** fall back to `ids[0]`, which would act on a session the operator is not looking at. `getSnapshot` must be invoked as a method; extracting the function drops the store's `this`.

`agent-instructions` is an **optional peer**: a minimal composition legitimately has neither it nor an agent. `instructionsApi()` returns `undefined` when the package is absent (contributing nothing), but **throws** when the package is present and carries neither renderer name — that is a compatibility break to fix, not an optional seam.

`@deepseek-ai/dsh-llm` is **also an optional peer, and it may only be loaded on demand**: the barrel (`src/index.ts`) is precisely the module the carrier loader row mounts, so its load-time dependency set must equal the required-package set, and any static value import would make a minimal composition — one that never builds a message at all — fail to load. Message construction goes through `createInstructionMessage()` in `src/compat/llm-message.ts`, which reaches `await import('@deepseek-ai/dsh-llm')` at the moment a message is actually built. `tests/optional-peers.spec.ts` pins this: loading `src/index.ts` and `src/instructions.ts` does not resolve the package.

`instructionsApi()` must also keep **"the package is absent"** and **"the package is present but fails to evaluate"** apart: `isPackageInstalled()` probes installation separately (`createRequire(import.meta.url).resolve`, the same pattern as `readInstalledVersion`), and only `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` counts as absence. Every other failure — a missing transitive dependency making the `import()` throw, say — must propagate rather than being cached as `undefined`, which would silently stop the whole process from delivering additional-root instructions.

## 5. `DSH_MULTI_ROOT_COMPAT=warn` is not a debugging switch for you

It exists for the upgrade lane only: to let the full matrix run against a release that is not on the allowlist yet.

It relaxes exactly **one** verdict: `unsupported` (a coherent tree on a release the allowlist simply has not named yet — the only shape the upgrade lane probes). `mixed` and `incomplete` are refused under **both** `enforce` and `warn`.

If the gate refuses locally, **do not** use it to carry on developing. The right move is to check whether your host / `node_modules` really is on the allowlist (`pnpm compat:check`). Use it only when you are genuinely promoting a new upstream release; that process is written down in [the troubleshooting entry](../../docs/troubleshooting/unsupported-dsh-release.md).

`upgrade.yml` sets it, the main CI lane does not, and `tests/workflows.spec.ts` pins that boundary.

## 6. The upgrade lane never widens the support matrix

`upgrade.yml` runs weekly with `contents: read`, does not commit or push, and does not touch `SUPPORTED_DSH_RELEASES`. A green run is **evidence**, not authorization. Promotion is a human act.

`compat:check` does **not** run in the upgrade lane: the candidate is by design not on the allowlist. If you add `run: pnpm compat:check` to that workflow, `tests/workflows.spec.ts` fails.

For upgrading and probing:

```bash
node scripts/upgrade-dsh.mjs 0.1.7-alpha.1          # repoint the pin
node scripts/upgrade-dsh.mjs --latest-prerelease     # pin the newest pre-release
node scripts/upgrade-dsh.mjs --print-latest-prerelease
node scripts/upgrade-dsh.mjs --print-installed       # what actually resolved
pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0
git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml   # revert
pnpm install --frozen-lockfile                                     # bring node_modules back too
```

Installing a candidate **requires** `--config.minimumReleaseAge=0`. Without it pnpm's release-age gate makes it append two hundred-odd lines of the fresh tree into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` — which a throwaway probe has no business leaving behind.

`0.1.7-alpha.1`'s `dsh` depends on cordis `^4.0.3`; `0.1.7-alpha.2`, `0.1.7-rc.1`, and `0.1.7-rc.2` depend on `~4.0.4`. `upgrade-dsh.mjs` repoints the `@deepseek-ai/cordis` dev pin and the cordis release-age line in `pnpm-workspace.yaml` to the exact version inside that range. Do not leave `4.0.2` in the same tree: pnpm then installs two copies of `@deepseek-ai/dsh-tools`, the `TOOL_RUNTIME_SCHEDULER` symbol `dsh-agent-loop` holds is local to its module, and it misses the ToolRuntime the other copy constructed. Tool calls then die on the first step with `Cannot read properties of undefined (reading 'prepare')`. Restoring the baseline pin puts cordis back at `4.0.2`.

Two traps that only bite locally (CI always starts from a clean checkout):

- **That `git checkout` reverts all three files to HEAD wholesale**, taking any uncommitted edit of yours with them. Commit or stash before probing over dirty manifests.
- Once the candidate is installed, pnpm's **pre-run dependency check** decides the tree is out of sync — over the very same release-age gate — and triggers a reinstall that also fails, leaving `node_modules` half torn down (no `.bin`, a one-entry `.package-map.json`). At that point `pnpm install` cheerfully reports "Already up to date" without repairing anything, and the only way out is `rm -rf node_modules` followed by a fresh install. To avoid it, step around pnpm's script wrapper while probing: `PATH="$PWD/node_modules/.bin:$PATH"` and then run `oxlint` / `tsc` / `vitest` / `node scripts/*.mjs` directly.

**Mixed-tree trap (hit for real on 2026-10-28)**: when repointing to an older release, pnpm prefers the cordis ecosystem entries already in the committed lockfile — `dsh-app-boot`'s `cordis-plugin-loader` / `-group` / `-include` peer ranges admit both stable and alpha versions, and an `rc.3` tree once ran its `0.2.1` runtime on loader `1.0.7-alpha.1`, where Settings volatile writes never reach the live Config (`tests/skills-settings.spec.ts`'s enabled assertion silently stays `true`). `upgrade-dsh.mjs` now additionally derives exact pins for `cordis-plugin-*`, `schemastery`, `cosmokit`, and `node-addon-system` from the target release's own `dsh` / `dsh-app-boot` / `cordis` / `dsh-sandbox-local` manifests, writes them into the same temporary `overrides` block, and repoints those packages' `devDependencies` pins to match; after repointing across a prerelease line, confirm the resolved loader/group/include are that release's own stable versions before trusting results.

## 7. The journey smoke's model endpoint speaks both wire dialects

`0.1.6-alpha.1` switched the default LLM protocol from chat completions to Messages:

```text
0.1.5-rc.2     POST {base}/chat/completions    choices[].delta, finish_reason
0.1.6-alpha.1  POST {base}/v1/messages         message_start / content_block_* / message_delta / message_stop
0.1.6-alpha.2  same dialect as 0.1.6-alpha.1 (journey 55/55, endpoint unchanged)
0.1.7-alpha.1  same dialect as 0.1.6-alpha.1 (journey 55/55, still `POST /v1/messages`)
0.1.7-alpha.2  same dialect as 0.1.7-alpha.1 (journey 55/55)
0.1.7-rc.1     same dialect as 0.1.7-alpha.1 (journey 55/55)
0.1.7-rc.2     same dialect as 0.1.7-rc.1 (`/v1/messages` is unchanged; a route that does not declare `toolUpdate` strips developer messages)
```

That change does not pass through plugin code, but it breaks the scripted endpoint in `scripts/smoke-journey.mjs`. The endpoint now picks its dialect **by request path**, built by `chatCompletionFrames()` and `messagesFrames()` respectively.

The same place holds a trap already stepped in once: **do not classify which request is an agent step by whether the body contains the title prompt**. Some releases send the whole session log with every request, so every request is classified as a title, the agent runs no steps at all, and the smoke reports two dozen downstream failures like "the model never saw the additional root". The discriminator is now **whether the request offers tools**.

To inspect what the model actually received:

```bash
DSH_SMOKE_KEEP=1 pnpm smoke:journey
# then read .dsh-smoke/journey-<pid>/model-requests.json
```

## 8. One command for the whole matrix

```bash
pnpm verify:all   # lint → typecheck → build → test → kernel:probe → smoke
```

It **deliberately excludes** `compat:check`, because the upgrade lane runs it against an unlisted release. The main CI lane runs `compat:check` separately, before lint.

## 9. DSH 0.2 and the new development baseline

At the time of this section the development pin was `0.2.0-rc.2`, with cordis `4.0.4` (see §1 for the current baseline). Restoring the baseline no longer means restoring `0.1.5-rc.2` / `4.0.2`; the earlier probes are historical records. Restore the manifest, workspace, and lockfile saved before a probe, then reinstall the tree. Never discard uncommitted support declarations by restoring HEAD.

`0.2.0-rc.1` and `rc.2` retain the seams handled by the existing adapters. The 0.2 agent loop records conservative failure `tool/result` events before closing a failed step: `message.isError: true`, plain-text content, and `data.error`. These must never count as successful file touches. `tests/instructions.spec.ts` covers old block-level failures, message-level failures, and recovery events. The inherited Windows provider softly registers the new ACL diagnosis skill; this plugin still does not promise Windows kernel multi-root grants. Risk analysis and per-release evidence live in the [roadmap record](../../docs/plans/active/2026-09-12-multi-root-workspace.md#dsh-02-兼容提升2026-09-30).

CI reads its version axis directly from the allowlist through `scripts/list-dsh-releases.mjs`. Every supported release runs on every enabled OS, always in enforce mode. `pnpm-workspace.yaml` lists exact release-age exceptions for transitive DSH packages and LibreOffice host tooling: pnpm 11 rejects version-qualified package-name wildcards and verifies the entire lockfile before running scripts. Candidate installs still use `--config.minimumReleaseAge=0`; restore temporary pins and exceptions afterwards.

The repointing script also derives workspace-only DSH / cordis `overrides` from those DSH entries, preventing old prerelease ranges from producing a mixed tree under runtime resolution. It refuses to replace custom overrides. This block belongs to the probe and is not shipped with the plugin; restore the saved workspace afterwards.

On Windows, Node cannot start `npm.cmd` with `execFileSync('npm')`; old-version matrix jobs fail before repointing with `spawnSync npm ENOENT`. The upgrade script uses `scripts/lib/npm-cli.mjs`: Windows runs the installation’s `node_modules/npm/bin/npm-cli.js` through the current Node executable, while POSIX still executes npm directly. No shell command is assembled; regression tests cover paths with spaces and argument boundaries.

## 10. New B1–B3 seams

LSP and workspace-files wrap public methods; unloading must restore original property descriptors. Do not compare Cordis proxy function references. `src/compat/workspace-files.ts` adapts old `changes(scope, signal)` and new `changes(scope, path, signal)` by arity. The read surface `stat`/`read`/`readBytes` is wrapped the same way — upstream gives it no workspace confinement, so the boundary comes from `routeWorkspacePath` plus a lexical check against `registry.list()`'s registered-but-withheld roots (refused `workspace-file/outside-workspace`); `readBytes`' third parameter is version-shaped (`WorkspaceByteRange` ↔ `WorkspaceByteReadOptions`). The wrapper preserves the range and other options, rewriting only `baseFile` during routing; related-path semantics are recorded in [ADR-0011's read-surface amendment](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md#修订面板-files--readfile-端点下线2026-10-12amendment). The pre-0.2 `readAll`/`readRelated` pair is wrapped by structural probe when a release still carries them. The Windows runner for a populated scope must use a SID for the entire root set: granting additional roots to the primary SID would retain write access after removal. Optional peers participate in mixed-tree checks and must stay out of carrier-barrel static imports. Whether a resolved copy TESTIFIES is split by who would actually load it (`src/compat/dsh-version.ts`): `RUNTIME_OPTIONAL_PACKAGES` are the ones this plugin dynamically `import()`s itself (`dsh-agent-instructions` / `dsh-llm` / `dsh-session` / `dsh-typert-protocol`) — a private copy genuinely executes, so any hit testifies; `HOST_SERVICE_PACKAGES` are consumed only as mounted host services or ambient types, so a copy landing INSIDE this package's own root can never run — a `link:`-installed checkout resolves `dsh-lsp` / `dsh-lsp-stdio` / `dsh-working-directory` to its own devDependencies, and not excluding that hit phantom-mixes a uniformly-versioned host into `mixed`. The host-anchor fallback (via `@deepseek-ai/dsh`'s package.json) applies only to these host-service packages and is bounded by the same plugin-root rule. A third category, `RUNNER_ANCHORED_PACKAGES`, covers `dsh-sandbox-windows-acl`: the standalone runner imports it by self-reference from `profile.upstreamRunner`, so the executing copy is the sibling in the installed `dsh-sandbox-local` tree — it is inspected only from that anchor (a miss is absent, since the runner could not load it either), and any anchored hit testifies (the anchor IS the executor chain, including hits inside the plugin root); self-resolution and the `dsh` host anchor do not reflect execution here. A new optional package must be filed under whichever list matches who loads its copy and through which anchor — never added to two lists. See [ADR-0011](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md) for the decision and the [roadmap](../../docs/plans/active/2026-09-12-multi-root-workspace.md#b1b3第二期-p12026-10-02) for platform validation.

## 11. DSH 0.2.1 directory semantics

The development baseline is now `0.2.2-rc.3` with Cordis `4.1.0`. Registry identity and grants remain tied to the immutable Session origin. Use the upstream workingDirectory service for effective cwd; never infer a session from a shared directory. Tool dispatch carries caller identity for LSP, while successful filesystem observations capture instruction touches. Exact candidates and native platform evidence are recorded only in the [roadmap ledger](../../docs/plans/active/2026-09-12-multi-root-workspace.md). See [ADR-0012](../../docs/decisions/ADR-0012-session-origin-and-effective-cwd.md) and the [interface review](../../docs/reference/dsh-0.2.1-migration.md).

The upgrade tool accepts a single Cordis prerelease version as well as stable versions; it never turns the pin into a range. New install-time peer checks require an exact allow-version exemption in disposable candidate smoke profiles; in warn mode the exemption is granted before the first `add` (the build-approval recovery path's internal remove+add hits the same version gate). This is restricted to the upgrade lane; production and the supported-version matrix use enforce. The existing installed package version is `0.1.6`, and the `v0.1.6` tag exists; the migration does not create a release.

Since `0.2.1-alpha.3`, `dsh-storage-domain` pins `zod` at `4.4.3` exactly instead of `^4.4.3`, splitting the tree into two resolutions alongside this package's floating `^4.6.x`; zod v4 brands its types by build minor, so `domainTable`'s declared `ZodType` only accepts a schema built by its own copy. Domain schemas (`persistedRoot` / `persistedPrimaryRoot` in `src/registry.ts`) must be built through `src/compat/storage-zod.ts`, which resolves zod from the storage-domain's own module path — value and boundary type stay same-source on every supported release. Never build domain schemas from a package-level `import { z } from 'zod'`, and never pin this package's zod to the upstream pin (the pre-`alpha.3` `^4.4.3` releases would split the tree on the other side). This package's own `zod` remains the validator for the panel wire schemas in `src/contract.ts` — that boundary is ours and unrelated to upstream's type family. Since `alpha.4`, upstream install gating prefers `engines.dsh` and falls back to `peerDependencies`; this plugin still treats the peers as its single version contract and does not introduce a second version list.

## 12. Upstream DOM hooks on the browser side (promotion checklist)

Two spots under `src/client/` depend on upstream structure that is **not part of the slot contract**; structural probes cannot cover them, only visual inspection can:

| Dependency | Consumer | What failure looks like |
| --- | --- | --- |
| `FilesBody`'s flat flex header and the `data-files-root` / `data-files-path` / `data-files-reload` attributes on the flex items | the `:has()` rules in `styles.ts` (`.mrfw-rootSwitcher` takes the path label's position and hides `[data-files-path]` — the switcher draws its own `PathLabel` (`.mrfw-switcherPath`) of the selected root's full path and its own `.mrfw-switcherReload` standing in for the native reload while an additional root is selected; with `[data-root-kind="additional"]` the rules hide `[data-files-body]` and `[data-files-reload]`) | the rules simply stop matching: the upstream path label returns and sits beside the switcher's own PathLabel (the path appears twice), and the switcher falls back to its in-slot position as a plain menu — a silent degradation, never a broken header |
| `closest('[data-files-root]')` hitting this pane | the portal target lookup in `RootSwitcher.tsx` | with no ancestor the forked tree is never rendered and selecting an additional root only changes menu state; the native layout is untouched |
| `data-dockkit-content` on the dockkit tab host (the tab id value) | the forked tree's store-bucket key in `RootSwitcher.tsx` (scroll/expansion memory) | with no attribute a generated id is used — function unaffected, only scroll/expansion memory does not survive takeovers; a renamed or moved attribute mismatches the bucket key against the native tab |
| the `data-open-target="directory"` attribute on the `ui-open-in-app` split button's anchor | the hide rule for the additional-root state (`:not(.mrfw-openSplit)` spares the forked button itself) | renamed/removed attribute → the native button resurfaces on additional roots and clicking it still opens the primary root (the old bug returns); the selector failing only affects hiding, never function |
| the `sidebar.right.tab.document.actions` slot (declared by `documentpreview` since `0.2.2-alpha.3`) | the preview navigator retarget's mount point in `navigator.tsx`; the owner's `absolutePath` is the previewed file's host path | host never declares the slot → no registration, the preview navigator stays fully native (it did not exist anyway); slot present but the owner field renamed → the occupant gets no path and renders nothing — the native tree is unaffected |
| `data-textpreview-url` on the preview root (the tab contentId) and `data-textpreview-content` on the content row | `navigator.tsx`'s preview location, the cross-session check (`parseFileAddress` must yield this session's session-scope address), and the aside watch scope | hooks absent/renamed → no preview found or the session check fails — the retarget never engages; the native navigator tree is unaffected |
| `aside[data-files-navigator]` (the dockkit pane id value) and the `[data-files-body]` inside it | `navigator.tsx`'s takeover target and pane bookkeeping key; `styles.ts`'s `aside[data-mrfw-navigator] > [data-files-body]` hide rule | no aside → never a takeover (the navigator is closed); value no longer a pane id → bucket/snapshot re-keyed, cross-`replaceTab` expansion/scroll memory lost but function intact |
| dockkit's pane carriers: a non-empty pane's id rides on its SELECTED tab's host (`data-dockkit-pane`), an empty pane's on its `TabPanel`, a floating pane's host uses `data-dockkit-float` — the pane itself has NO stable element | `navigator.tsx`'s pane-death observation is query-based (the pane lives while some connected element still carries its id), and the death watch lives outside the takeover lifecycle — the body's cleanup always wins that race | changed attribute spelling/ownership → survival verdicts skew: a false death drops snapshots early (memory degrades, function intact); a false survival keeps them until session end |

⚠️ `data-files-path` has a **dual meaning**: the header `PathLabel` carries it bare (`"true"`), but **every tree row** (the `li` with `data-files-entry`) carries it too, with that row's own absolute path as the value. Any selector meant to hit the header label must be written `[data-files-path]:not([data-files-entry])` — an unqualified `display:none`/`order` acts on the whole native tree (this actually happened: the primary-root tree area went completely blank). The other three hooks (`root`/`body`/`reload`) each appear exactly once.

When promoting an upstream release (the manual acceptance after a green upgrade-lane run), verify three states by eye: with no additional roots the Files tab looks native; with an additional root selected the tree area shows the verbatim fork of the native Files tree (row height/icons/indent/empty/truncated/failure rows should match the native tree exactly), the reload spot shows the plugin's `.mrfw-switcherReload` stand-in, and the native open-in-app button is replaced by the forked one (its chevron menu should look identical to the native one); switching back to the primary root restores all three. The preview-side Folder navigator has four states of its own: previewing an additional-root file and opening Folder → the tree roots at that additional root, ancestors already expanded, the current file highlighted inside the viewport, and a file opened from the tree replaces the preview's own tab while the tree stays on the new tab's pane; previewing a primary-root file → the native navigator tree unchanged (root=cwd); collapsing then expanding Folder → expansion and scroll return to where they were left, and the kept rows draw immediately without a loading flash; switching the same preview pane from additional root A to B and back → A's collapse and scroll each come back, and B's address never lands in A's `revealed` (the two roots' memories stay apart). If any state is off, first check whether the five `data-*` attributes still sit on the corresponding flex items (`.header` / `.body` class names are CSS-module hashes and cannot anchor anything). Symptoms and the fix live in the [troubleshooting entry](../../docs/troubleshooting/files-switcher-degraded.md); the decision is [ADR-0015](../../docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md).

**The files-tree legacy fork**: `src/client/files-tree/` keeps a byte-for-byte fork of upstream's `ui-sidebar-files` tree body for older hosts (baseline `f3803c9697` = `0.2.2-alpha.2`; file list, shim table, shell deltas and the sync procedure live in that directory's `FORK.md`). When changing that legacy baseline, re-copy per FORK.md and compare — `directory-node.ts`/`store.ts`/`FilesBody.module.css` and `FilesBody.tsx`'s row-level definitions must stay byte-identical; `face.ts` carries the hold/release lifecycle delta (`start`/record abort reseeds or forgets the bucket, `hold`/`release` let a closed Folder close only the node/watches and keep the listed levels), with the rest still byte-identical. The permitted diffs are: the shell function's root-source rewrite, the `.ts` suffix on the css specifier, the file row's reveal marks (the `ref`/`data-files-current`/`aria-current` on `Entry`'s button and `TreeContext`'s `current`/`currentRef`), the `reveal`/`saved`/`onScrollOffset` props and their shell logic, and the body's `tabIndex` plus its NATIVE `scroll` listener (delegated events never reach outside the portal, so the listener must sit on the element itself); also check whether upstream's `locales.ts` `zh` key set grew (the shim's `SidebarFilesKey` union must follow), and whether the `workspaceFiles` remote face or the `data-dockkit-content` hook drifted. The fork spells `mrfw-ft*` classes and carries no `data-files-root`/`data-files-body` (so the plugin's own `:has()` hide rules cannot hit it); when the primitives probe fails the whole forked tree simply does not render (same-shaped degradation, never a crash). **The remote face must resolve lazily through `ctx.get`**: `remote.workspaceFiles` is a cordis nested service — the context-proxy path (`remote.workspaceFiles` or `ctx['remote.workspaceFiles']`) is inject-guarded (undeclared fibers throw `without inject`), and every inject entry in this cordis is required (declaring it would gate the whole row on an optional service). `lazyFilesRemote` therefore reads `ctx.get('remote')` / `ctx.get('remote.workspaceFiles')` straight from the store, folding every lookup failure into a `gateway/internal` failure row — the verbatim `load` awaits `list` via `.then` with no `.catch`, so an escaped rejection would silently pin the level at `loading` forever. **The compile face is pinned to the dev pin too**: before `0.2.0-rc.2` `workspaceFiles.changes` takes two parameters (a session-wide watch), so `tsconfig.client.json`'s `paths` maps `@deepseek-ai/dsh-api-remotes/client` to `client-remote.d.ts` — a local declaration spelling the path-watch-era 3-argument signature — letting the verbatim `face.ts` typecheck on older matrix manifests. It is safe because the `files.actions` slot does not exist there, so the call can never execute.

**The open-in-app fork**: `src/client/open-in-app/` is a byte-for-byte fork of upstream's `ui-open-in-app` client package (baseline `ddac96760b` = `0.2.2-rc.2`; file list, shim table and the sync procedure live in that directory's `FORK.md`). When changing that legacy baseline, re-copy per FORK.md and compare — the permitted diffs are the `.ts` suffix on the css specifier in `OpenTargetButton.tsx` plus open-toast.tsx's two lines (the dropped layout side-effect import and `isMobileDevice` from `./device.ts`, which re-exports the probe shim in `src/compat/open-in-app-device.ts`); also check whether upstream's `locales.ts` `zh` key set grew (the shim's `OpenInAppKey` union must follow), whether `shared.ts` route constants changed (the devDependency version is the provenance record), and whether the `OpenInAppActionInjected` hook names drifted. The forked components spell the `*Regular` icon family: on 0.1.5/0.1.6 pixel-named runtimes no adapter is built and no button renders (same-shaped degradation, never a crash).

## 13. The B9 process-fence seam (Full-access bypass)

Across all nineteen supported releases, every process surface skips `ctx.sandbox.confine()` under `danger-full-access`: the bash/pwsh executors' `execute` (plus `start` on `0.1.5/0.1.6`), `dsh-terminal-bash`'s module-private `spawnArgv`, and `dsh-ptc-runtime-node` (run_code). The subprocess spec carries no `sandboxPolicy`, so the authorization intent cannot be recovered at a lower layer — the `multi-root-process-fence` row injects a deny context through `AsyncLocalStorage`: wrapping `ctx.shell.execute` (legacy `run` / `start`) / `ctx.ptcRuntime.run` installs the context, and `ctx.subprocess.spawn` rewrites the argv only when the context is present. The only reachable PTY seam is the shared `ctx.subprocess.spawnTerminal` (the `persistent-shell` group has `isolate: terminals`, so its backend is unreachable); the session is recovered from `env.DSH_SESSION_ID` (`Agent.enter` forces `agent.id === session.id`) and resolved via `sandboxPolicy.resolve({session})`; an unresolvable session with any explicit read-only root registered fails closed. The restricted prefix never calls private runner methods: it probes `super.confine(['true'])` under a read-only policy to obtain the profile skeleton, then applies `restrictProfileArgs` (preserving the sync/async shape). See [ADR-0017](../../docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) for the decision and `tests/process-fence.spec.ts` for the harness.

The concrete PTC `execute` helper is private; wrap public `run`. Decode a Windows UTF-16 pointee with `koffi.decode(ptr, 'char16_t', -1)`, not `str16`: the latter dereferences the first code units as another pointer and crashes natively. The old attribute candidate queries TokenSecurityAttributes with native UNICODE_STRING records; never mix these with Win32 claim PWSTR records. The runner receives a broker token handle, then verifies each root's deny-only, non-enabled group in the derived token's normal TokenGroups. A broker ACK alone is insufficient. Normal deny-only groups and the removable restricting SID list are separate lists. ADR-0020 owns installation and security boundaries; this note does not duplicate progress.

The agent-vs-user PTY discrimination is §13's only silent fail-open seam: `DSH_PTY_SESSION_ID` is stamped only on the agent PTY launch path (the panel's terminal controller stamps only `DSH_SESSION_ID`), so if a downstream release stops stamping it, agent PTYs pass through as user terminals. `src/compat/pty-marker.ts` probes the installed `@deepseek-ai/dsh-terminal-bash` build output for the constant at startup — it checks artifact content, not a version number or an in-process shape (a remotely bundled or pruned build can be verified without executing its code). A missing backend means no PTY seam and is allowed; a backend present without the marker refuses plugin load — `DSH_MULTI_ROOT_COMPAT=warn` does not relax it (warn admits an unlisted-but-coherent candidate version, not a broken contract). Tests live in `tests/pty-marker.spec.ts`.

Older Windows process binding tables may omit `GetFileType`. The fd 7 adapter fills this operation through public `extendWin32ProcessBindings`; do not assume the development pin’s table shape.

## 14. DSH 0.2.2 seams and quiet traps

`0.2.2-alpha.2` is a 2000+ commit jump (no alpha.1 tag after rc.4). Plugin source needs no adapter, but the test and host composition changed in ways worth knowing:

- **`AgentRegistry` declares `static inject = ['sessionProjections']`**: any test stack must mount `SessionProjectionRegistry` before `ctx.plugin(AgentRegistry)`, or `ctx.agents` stays silently `undefined` and the first `ctx.agents.enter()` throws `Cannot read properties of undefined (reading 'enter')` — a fixture gap, not a plugin defect. `sessionProjections.register()` is now async and returns a handle; `registry.stateOf(session, key)` is deprecated.
- **Tool execution left `dsh-tools`**: executors are separate rows (`dsh-tool-executor-native` / `-ptc`), `ctx.tools.execute` takes batch `calls` input, and the `@deepseek-ai/dsh-tools/pipeline` subpath exists only from 0.2.2 on. The test-side handling lives in `tests/support/tool-executor.ts`: it mounts an equivalent dispatcher only when `ctx.tools.setExecutor` exists, and dispatches batch vs single-call shapes. **Careful**: a literal `import('@deepseek-ai/dsh-tools/pipeline')` is resolved by Vite at transform time and crashes the whole spec file on releases without the export — the dynamic specifier must not be statically analyzable — build it as a template-string concatenation rather than one literal.
- **Native third writable-root path in Sandbox**: `SandboxExecutionPolicy.additionalWritableRoots` + `workspaceWritableRoots` (policy service key `sandboxPolicy.additionalWritableRoots`) are consumed natively by Seatbelt/bwrap/Landlock/fs-sandbox; windows-acl rejects them with `SandboxUnsupportedPolicyError`. This plugin never sets the field — its widening still comes from its own scope, and the composition of both grant paths is pinned by `tests/upstream-additional-roots.spec.ts` (structurally skipped via the `workspaceWritableRoots` export probe on older releases).
- **Session/storage**: store-owned Sessions refuse appends until `session/created` completes — plugin tests use independent Sessions and are unaffected. `dsh-storage-domain` adds `deleteRecords`/`deleteMany` and an `unknown-state` quarantine, all additive.
- **Node >=24.9**: 0.2.2+ lanes need Node 24; CI routes known old prefixes (0.1.*/0.2.0/0.2.1) to 22.19.0 and everything newer to 24.9.0.
- **Auto Review stays put**: upstream's experimental auto-review changed in 0.2.2 (one request message per history item, `AutoReviewFailedError`, unload rule), but the optional fork stays on its exact `0.2.1-rc.2` baseline — `AUTO_REVIEW_RELEASE` does not move with the dev pin.
- **Upstream skills semantics nudge**: the filesystem provider now reports failed roots as an incomplete observation and tool-skill publishes an incomplete catalog; this plugin's multi-root skills provider still reads nested observations as plain candidates and ignores `complete:false` — behavior unchanged, noted as a known follow-up.


## 15. DSH 0.2.2-alpha.3 seams

The backend adds patch, delete and two-ended move mutations. Never inherit them unfenced: the structural adapter installs wrappers only where the backend supplies them, and both move targets use one Registry admission. Cordis also changed getter tracing; the Connection adapter binds the public RPC getter to the consuming fiber. The new Files page uses the host tree Factory, retaining the alpha.2 fork for older surfaces. See the [interface review](../../docs/reference/dsh-0.2.2-migration.md#022-alpha3-后续审查2026-11-04) and each fork's sync instructions.

The upgrade probe pins a prerelease vendor range to its declared base, even when npm reports a later admitted prerelease. Mixing the alpha.2 loader with alpha.1 Cordis breaks the older host; at the alpha.3 stage, stable ranges still selected the highest admitted version (superseded by §16).

## 16. DSH 0.2.2-rc.1 release transition

The rc.1 patch against alpha.3 changes package versions only. Keep the existing adapters and the named prerelease peer alternatives for older hosts; the stable peer ranges already cover Cordis 4.1.0 and Schemastery 3.19.0. Repoint the development tree coherently and remove temporary probe overrides before committing. Stable vendor ranges must stay on the latest stable patch in their declared minor line (prereleases still pin the exact base): the old `^1.0.3` loader peer admits the newly published `1.1.0`, which crashes Cordis `4.0.2` at `fiber.entry`. The upgrade helper now rejects an unpublished base or a compound range rather than crossing into a newer vendor minor or mixing a prerelease into a stable line. See the [interface review](../../docs/reference/dsh-0.2.2-migration.md#022-rc1-后续审查2026-11-05); execution evidence remains in the roadmap ledger. Auto Review retains its exact 0.2.1-rc.2 baseline.

## 13. The New Session Hero entry (`conversation.hero.options`)

`conversation.hero.options` is a `list` / `session` slot declared by `ui-conversation` since `0.2.1-alpha.3` (commit `3f1d5dfcfa`) and rendered after the workspace and mode selectors in the blank-session hero row; `.heroOptions` carries `margin-left: auto`, so the entries sit at the row's right edge. This plugin registers `multi-root-folders.hero` there (order 10, no `label`); the occupant uses the composed `sessionId` and memoizes it into a stable callback, sharing `WorkspaceFoldersDialog`, the RPC surface, error codes, and copy with the sidebar `sidebar.footer.action`. The slot is a `list`, its outlet uses `display: contents` inside `.heroOptions`, and this entry neither grows nor positions itself absolutely nor spans the width, so it does not monopolize the slot; a single visible entry is an installation fact in the current composition.

- **Availability**: `0.2.1-alpha.3` and newer; `0.1.5-rc.2` through `0.2.1-alpha.2` do not declare the slot.
- **Absence behaviour**: `ctx.slots.inject` silently never fires and the New Session page has no such entry; the sidebar entry, the host half, RPC, and authority semantics are all unchanged.
- **Dependency shape**: **no** `ui-conversation` dependency (no type import, no devDependency, nothing in `dsh.client.inject`). The typecheck matrix includes releases before `0.2.1-alpha.3`, whose SlotMap lacks the key; the registration goes through a narrow structural face (`inject` + `spec` + `register`), and `spec` returning no declaration returns an empty disposer. Only releases that declare the slot register and show the entry; older releases show nothing and the sidebar entry is unaffected.
- **Probe with the public `spec`, never `specDynamic`**: `specDynamic` lives only on `SlotCore`; `ctx.slots` (`SlotRegistry`) exposes `spec`, `entries`, and friends. Test doubles must use the real `SlotRegistry`, or they will fake a service method that does not exist. `tests/client-slot-probe.spec.ts` loads the browser module bundle, instantiates the real service, declares the slot, and asserts the hero registration.
- **Session authority**: the slot is `session` scope and the composed `sessionId` is definite; do not fall back to the global current-session resolver inside the hero occupant (the sidebar fallback is a separate path).
- **Shape constraints**: the same geometry as the adjacent workspace and mode selectors, but deliberately **no chevron** because it opens a dialog, not a menu; the icon prefers `IconWorkspaceTreeOutlineRegular` and, through `selectIconOr`, falls back to `IconFolderOpen` on older runtimes (never a pixel-era name); the label leads and the glyph sits on the right, matching the right-aligned row; the trigger adds `margin-right: 4px` because the upstream row pads `0 16px 0 20px`, putting its box at the same 20px inset as the workspace selector. **Width adaptation**: `.heroOptions` is `flex: none`, so the row never squeezes an entry; `measureHeroEntryRoom` pins the seat to its icon floor (`data-measuring` → 28px, label hidden), reads the options group's budget (from the preceding control plus the flex gap to the row's content edge, less the other occupants, the group gaps and the seat's own inset), and writes it to `--mrfw-hero-entry-room` for the stylesheet to clamp. Under 88px the entry renders `data-size="compact"` and keeps the icon alone. The probe relies on three structural facts — the options container is a flex item, the slot outlet is `display: contents`, and the options group is the row's last item — all of which hold in the installed sources from `0.2.1-alpha.3` through `0.2.2-rc.3`. If any stops holding the probe returns `null` and the stylesheet falls back to the content width plus the 560px viewport step. If upstream adds a container to that row or lets `.heroOptions` shrink, re-evaluate the probe.
- **No DOM hooks**: the entry depends only on the slot contract; if upstream renames or removes the slot, it degrades silently through the absence path above and the visual-inspection table needs no update.

## 17. DSH 0.2.2-rc.2 support and release

- **Status**: upstream tag `dsh-v0.2.2-rc.2` points at `ddac96760b`, and npm now publishes it (`next` names this release; `latest` is still `0.2.2-rc.1`). This branch promotes `SUPPORTED_DSH_RELEASES`, every DSH peer range, and the development pin to `0.2.2-rc.2` (23 exact releases), and repoints the development tree with `scripts/upgrade-dsh.mjs 0.2.2-rc.2`. Temporary probe overrides are removed. The ten transitive packages new in this release (`dsh-agent-team`, `dsh-client-ui-account-notifications`, `dsh-client-ui-agent-team`, `dsh-error`, `dsh-mcp-manager`, `dsh-office-kit`, `dsh-terminal-panel`, `dsh-tool-agent-team`, `dsh-tool-office`, `dsh-util-ripgrep`) were added to `minimumReleaseAgeExclude`; without them a frozen install is rejected by the release-age gate.
- **New seams**: `dsh-sandbox` replaces uncoded failures with `SandboxPreparationError` / `SandboxEscalationError`, and Windows ACL now ignores extra roots for processes instead of refusing; `SandboxPolicyService.registerWritableRoot` merges a Session's directory into `resolve()`'s extra roots; `workspaceFiles.search` searches through packaged ripgrep and `ctx.subprocess`; `dsh-error` is the new shared `HarnessError` base; `dsh-subprocess` and `working-directory` use coded errors, the latter adding the `working-directory/access` waterfall. The plugin consumes all of these structurally and adds no version comparison.
- **Quiet trap 1 (Windows ACL semantics flip)**: upstream now **ignores** `additionalWritableRoots` for Windows processes and lets only file tools honor them; the plugin's own scope roots still reach processes through the ACE arguments `widenWindowsProfile` grafts. Keep the two paths apart. The per-Session section of `tests/upstream-additional-roots.spec.ts` pins "a native registration is fs-writable, a scope read-only denial still wins".
- **Quiet trap 2 (authority downgrade first)**: a `registerWritableRoot` grant travels through the policy into `writableRoots()` and the POSIX profile, but while the authority is unavailable the plugin still keeps only the primary root and the explicit denies. Upstream having authorized a directory is not evidence that this Host can read its registry.
- **Quiet trap 3 (search root)**: `workspaceFiles.search` takes the shared authority's admission and is not routed across roots, because its root is the Session cwd. It is **session-root bounded**: a canonical search root that sits under a registered-but-withheld boundary is refused before ripgrep starts. While a takeover shows an additional root, the native search bar, its status line, and the Files-page toggle hide with the native body; primary-root browsing keeps the upstream behavior.
- **Quiet trap 4 (fork baselines)**: rc.2's `ui-open-in-app` fork sources changed in comments only and gain the `menu.openIn` key; this branch re-copied `OpenInAppAction.tsx` / `controller.ts`, moved the baseline to `ddac96760b`, and added `menu.openIn` to `OpenInAppKey`. The legacy files-tree fork stays at alpha.2.
- **Contract check**: `@deepseek-ai/dsh-error` joined `OPTIONAL_CORE_PACKAGES` and `HOST_SERVICE_PACKAGES` (testified only through the host anchor, to catch a split cross-package singleton); do **not** add it to `peerDependencies` — rc.1 does not ship the package and installs on older hosts would fail.
- **Verification (published package)**: on the published `0.2.2-rc.2` development tree, `compat:check`, lint, both type checks, `build`, `docs:check`, `pack:check`, and `auto-review:fork` pass; the full vitest run reports **1368 passed / 162 skipped / 17 failed**. All 17 failures are sandboxed-peer registry IPC cases caused by this Seatbelt session; the rc.1 baseline fails the same 17 here (1364 / 166), so they are not an rc.2 regression. Locally `smoke:compose` is **56/56**, `smoke:behavior` **96 passed / 8 skipped**, `smoke:journey` **85 passed / 2 skipped**, and `smoke:packed` **95 passed / 8 skipped**, all with zero failures (the skips are the unavailable kernel runner and shared IPC inside Seatbelt). The three-OS matrix and native Windows ACL results come from the PR's CI run ([run 43227479998](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43227479998), 94/94 jobs); browser inspection is not a CI item and is recorded as local evidence in the roadmap ledger.

## 18. DSH 0.2.2-rc.3 support

- **Status**: upstream tag `dsh-v0.2.2-rc.3` points at `38a6a5c965`, and npm publishes it (`next` names this release; `latest` is still `0.2.2-rc.1`). This branch promotes `SUPPORTED_DSH_RELEASES`, all 28 DSH peer ranges, and the development pin to `0.2.2-rc.3` (24 exact releases), and repoints the development tree with `scripts/upgrade-dsh.mjs 0.2.2-rc.3`. Probe overrides are removed, and the only transitive package new in this release, `dsh-deepseek-chat-import`, was added to `minimumReleaseAgeExclude`.
- **Upstream delta**: rc.3 contains six commits and 515 files; 380 `package.json` files only replace version strings, and the rest is the New-session HOC slot in `ui-sidebar`, the `workspace.picker` Factory plus its third directory-flow hole in `ui-workspace`, both directory-picker packages, the upload icons in `ui-primitives`, the optional experimental `dsh-deepseek-chat-import` bundle, the unreadable-attachment fallback in `session-log-export`, and desktop-installer/CI work. None of the sandbox, fs, tools, session, storage, skills, lsp, workspace-files, or Connection seams the plugin consumes changed, so **no adapter branch was added**.
- **Quiet trap 1 (peer-only copies)**: after the upgrade, `dsh-permission-presets` and `dsh-util-values` could still satisfy peer edges with rc.2 copies (every rc.3 package declares an exact peer), and `pnpm peers check` must report zero. `pnpm dedupe`, `--force`, and `--lockfile-only` never rewrite such “still valid” edges; force both to the same exact release before landing, so `0.2.2-rc.2` remains in the lockfile only inside peer range strings.
- **Quiet trap 2 (the new package is not a contract member)**: `dsh-deepseek-chat-import` is not mounted by default and shares no surface with the plugin's authorization, so it does not join `OPTIONAL_CORE_PACKAGES`. Its own `zod 4.6.6` and `dsh-storage-domain`'s `4.4.3` are two independent copies; domain schemas still come only from `storage-zod`.
- **Quiet trap 3 (the picker's third hole)**: `workspace.picker.directoryFlow` is declared by the `workspace.picker` Factory. The plugin leaves it unoccupied and must not hang its own root UI into the host's New-session/picker flows.
- **Quiet trap 4 (New-session DOM)**: `sidebar.session.action` inserts a `display: contents` anchor between `.newSessionRow` and the button; `sidebar.footer.action` stays in the footer and is unaffected. Registering that HOC slot later must return `children` unchanged instead of adding a wrapper box.
- **Fork baselines**: rc.3 changed no file under `ui-open-in-app`'s or `ui-sidebar-files`' `src/client/`, so the open-in-app baseline stays `ddac96760b` and the legacy files-tree baseline stays `f3803c9697`; `FORK.md` only records that the dev pin moved while the baseline did not.
- **Verification (published package)**: `compat:check` (allowlist, peers, development pin, and the installed tree agree on 24 exact releases; `pnpm peers check` reports no issues), lint, both type checks, `build`, `docs:check`, `pack:check` (210 members), and `auto-review:fork` pass. The full vitest run is **1386 passed / 162 skipped / 17 failed**; all 17 failures remain this session's Seatbelt sandboxed-peer registry IPC cases, the same shape as the rc.2 baseline. Host smokes: compose **56/56**, behavior **96 passed / 8 skipped**, journey **85 passed / 2 skipped**, packed **95 passed / 8 skipped**, none failing. The three-OS matrix and the native Windows ACL results come from the PR's CI.
