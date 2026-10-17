# The DSH compatibility contract: what an Agent needs to know first

中文：[dsh-compat-contract.md](./dsh-compat-contract.md)

This note records the compatibility machinery you must understand **before changing this repository**, because it is easy to trip over. The reasoning lives in [ADR-0009](../../docs/decisions/ADR-0009-dsh-compat-contract.md) and the operator-facing diagnosis in [the troubleshooting entry](../../docs/troubleshooting/unsupported-dsh-release.md). This note only covers what you, as an Agent, will run into.

## 1. One source of truth for the support matrix

```text
src/compat/dsh-version.ts  →  SUPPORTED_DSH_RELEASES
```

It is an array of **exact versions**, not a semver range. Currently:

```ts
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2'] as const
```

When you change it, these four must agree or `pnpm compat:check` fails:

```text
src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   the allowlist
package.json                peerDependencies         "0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2 || 0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2"
package.json                devDependencies          one entry of the allowlist (currently 0.2.1-alpha.2)
node_modules                resolved versions        one entry of the allowlist
```

`scripts/check-dsh-compat.mjs` reads that array out of the TypeScript source as **text**, not by importing it. So: **do not rewrite it into anything other than an `export const NAME = [...]` literal** (assembled from elsewhere, wrapped in an expression other than the type assertion, and so on) — the static checker throws outright. The reason is that this check must run before `pnpm build`, on a clean checkout with no `lib/`.

## 2. Your tests may fail because of the gate — and that is correct

`multi-root-compat` is the first row in the patch, and these four inject it:

```text
multi-root-fs
multi-root-sandbox
multi-root-registry
multi-root-instructions
multi-root-lsp
multi-root-workspace-files
```

Cordis will not start a row whose injected service is absent. So before mounting any of those providers in a test you must first:

```ts
import { mountCompat } from './support/compat.ts'

await mountCompat(ctx)
```

Otherwise `ctx.get('fs')` / `ctx.get('sandbox')` are `undefined` and you will see errors like `Cannot read properties of undefined (reading 'confine')`. That is not a bug; it is the gate working (`tests/compat.spec.ts` asserts this behavior explicitly).

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

The development pin is `0.2.0-rc.2`, with cordis `4.0.4`. Restoring the baseline no longer means restoring `0.1.5-rc.2` / `4.0.2`; the earlier probes are historical records. Restore the manifest, workspace, and lockfile saved before a probe, then reinstall the tree. Never discard uncommitted support declarations by restoring HEAD.

`0.2.0-rc.1` and `rc.2` retain the seams handled by the existing adapters. The 0.2 agent loop records conservative failure `tool/result` events before closing a failed step: `message.isError: true`, plain-text content, and `data.error`. These must never count as successful file touches. `tests/instructions.spec.ts` covers old block-level failures, message-level failures, and recovery events. The inherited Windows provider softly registers the new ACL diagnosis skill; this plugin still does not promise Windows kernel multi-root grants. Risk analysis and per-release evidence live in the [roadmap record](../../docs/plans/active/2026-09-12-multi-root-workspace.md#dsh-02-兼容提升2026-09-30未发布).

CI reads its version axis directly from the allowlist through `scripts/list-dsh-releases.mjs`. Every supported release runs on every enabled OS, always in enforce mode. `pnpm-workspace.yaml` lists exact release-age exceptions for transitive DSH packages and LibreOffice host tooling: pnpm 11 rejects version-qualified package-name wildcards and verifies the entire lockfile before running scripts. Candidate installs still use `--config.minimumReleaseAge=0`; restore temporary pins and exceptions afterwards.

The repointing script also derives workspace-only DSH / cordis `overrides` from those DSH entries, preventing old prerelease ranges from producing a mixed tree under runtime resolution. It refuses to replace custom overrides. This block belongs to the probe and is not shipped with the plugin; restore the saved workspace afterwards.

On Windows, Node cannot start `npm.cmd` with `execFileSync('npm')`; old-version matrix jobs fail before repointing with `spawnSync npm ENOENT`. The upgrade script uses `scripts/lib/npm-cli.mjs`: Windows runs the installation’s `node_modules/npm/bin/npm-cli.js` through the current Node executable, while POSIX still executes npm directly. No shell command is assembled; regression tests cover paths with spaces and argument boundaries.

## 10. New B1–B3 seams

LSP and workspace-files wrap public methods; unloading must restore original property descriptors. Do not compare Cordis proxy function references. `src/compat/workspace-files.ts` adapts old `changes(scope, signal)` and new `changes(scope, path, signal)` by arity. The read surface `stat`/`read`/`readBytes` is wrapped the same way — upstream gives it no workspace confinement, so the boundary comes from `routeWorkspacePath` plus a lexical check against `registry.list()`'s registered-but-withheld roots (refused `workspace-file/outside-workspace`); `readBytes`' third parameter is version-shaped (`WorkspaceByteRange` ↔ `WorkspaceByteReadOptions`). The wrapper preserves the range and other options, rewriting only `baseFile` during routing; related-path semantics are recorded in [ADR-0011's read-surface amendment](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md#修订面板-files--readfile-端点下线2026-10-12amendment). The pre-0.2 `readAll`/`readRelated` pair is wrapped by structural probe when a release still carries them. The Windows runner for a populated scope must use a SID for the entire root set: granting additional roots to the primary SID would retain write access after removal. Optional peers participate in mixed-tree checks and must stay out of carrier-barrel static imports. See [ADR-0011](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md) for the decision and the [roadmap](../../docs/plans/active/2026-09-12-multi-root-workspace.md#b1b3第二期-p12026-10-02) for platform validation.

## 11. DSH 0.2.1 directory semantics

The development baseline is now `0.2.1-alpha.2` with Cordis `4.0.5-alpha.1`. Registry identity and grants remain tied to the immutable Session origin. Use the upstream workingDirectory service for effective cwd; never infer a session from a shared directory. Tool dispatch carries caller identity for LSP, while successful filesystem observations capture instruction touches. Exact candidates and native platform evidence are recorded only in the [roadmap ledger](../../docs/plans/active/2026-09-12-multi-root-workspace.md). See [ADR-0012](../../docs/decisions/ADR-0012-session-origin-and-effective-cwd.md) and the [interface review](../../docs/reference/dsh-0.2.1-migration.md).

The upgrade tool accepts a single Cordis prerelease version as well as stable versions; it never turns the pin into a range. New install-time peer checks require an exact allow-version exemption in disposable candidate smoke profiles. This is restricted to the upgrade lane; production and the supported-version matrix use enforce. The existing installed package version is `0.1.5`, and the `v0.1.5` tag exists; the migration does not create a release.

## 12. Upstream DOM hooks on the browser side (promotion checklist)

Two spots under `src/client/` depend on upstream structure that is **not part of the slot contract**; structural probes cannot cover them, only visual inspection can:

| Dependency | Consumer | What failure looks like |
| --- | --- | --- |
| `FilesBody`'s flat flex header and the `data-files-root` / `data-files-path` / `data-files-reload` attributes on the flex items | the `:has()` rules in `styles.ts` (`.mrfw-rootSwitcher` takes the path label's position and hides `[data-files-path]` — the switcher draws its own `PathLabel` (`.mrfw-switcherPath`) of the selected root's full path and its own `.mrfw-switcherReload` standing in for the native reload while an additional root is selected; with `[data-root-kind="additional"]` the rules hide `[data-files-body]` and `[data-files-reload]`) | the rules simply stop matching: the upstream path label returns and sits beside the switcher's own PathLabel (the path appears twice), and the switcher falls back to its in-slot position as a plain menu — a silent degradation, never a broken header |
| `closest('[data-files-root]')` hitting this pane | the portal target lookup in `RootSwitcher.tsx` | with no ancestor the forked tree is never rendered and selecting an additional root only changes menu state; the native layout is untouched |
| `data-dockkit-content` on the dockkit tab host (the tab id value) | the forked tree's store-bucket key in `RootSwitcher.tsx` (scroll/expansion memory) | with no attribute a generated id is used — function unaffected, only scroll/expansion memory does not survive takeovers; a renamed or moved attribute mismatches the bucket key against the native tab |
| the `data-open-target="directory"` attribute on the `ui-open-in-app` split button's anchor | the hide rule for the additional-root state (`:not(.mrfw-openSplit)` spares the forked button itself) | renamed/removed attribute → the native button resurfaces on additional roots and clicking it still opens the primary root (the old bug returns); the selector failing only affects hiding, never function |

⚠️ `data-files-path` has a **dual meaning**: the header `PathLabel` carries it bare (`"true"`), but **every tree row** (the `li` with `data-files-entry`) carries it too, with that row's own absolute path as the value. Any selector meant to hit the header label must be written `[data-files-path]:not([data-files-entry])` — an unqualified `display:none`/`order` acts on the whole native tree (this actually happened: the primary-root tree area went completely blank). The other three hooks (`root`/`body`/`reload`) each appear exactly once.

When promoting an upstream release (the manual acceptance after a green upgrade-lane run), verify three states by eye: with no additional roots the Files tab looks native; with an additional root selected the tree area shows the verbatim fork of the native Files tree (row height/icons/indent/empty/truncated/failure rows should match the native tree exactly), the reload spot shows the plugin's `.mrfw-switcherReload` stand-in, and the native open-in-app button is replaced by the forked one (its chevron menu should look identical to the native one); switching back to the primary root restores all three. If any state is off, first check whether the five `data-*` attributes still sit on the corresponding flex items (`.header` / `.body` class names are CSS-module hashes and cannot anchor anything). Symptoms and the fix live in the [troubleshooting entry](../../docs/troubleshooting/files-switcher-degraded.md); the decision is [ADR-0015](../../docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md).

**The files-tree fork**: `src/client/files-tree/` is a byte-for-byte fork of upstream's `ui-sidebar-files` tree body (baseline `d743267388` = `0.2.1-alpha.2`; file list, shim table, shell deltas and the sync procedure live in that directory's `FORK.md`). On promotion, re-copy per FORK.md and compare — `directory-node.ts`/`face.ts`/`store.ts`/`FilesBody.module.css` and `FilesBody.tsx`'s row-level definitions must stay byte-identical; the permitted diffs are only the rewritten shell function (the root prop adaptation) and the `.ts` suffix on the css specifier; also check whether upstream's `locales.ts` `zh` key set grew (the shim's `SidebarFilesKey` union must follow), and whether the `workspaceFiles` remote face or the `data-dockkit-content` hook drifted. The fork spells `mrfw-ft*` classes and carries no `data-files-root`/`data-files-body` (so the plugin's own `:has()` hide rules cannot hit it); when the primitives probe fails the whole forked tree simply does not render (same-shaped degradation, never a crash). **The remote face must resolve lazily through `ctx.get`**: `remote.workspaceFiles` is a cordis nested service — the context-proxy path (`remote.workspaceFiles` or `ctx['remote.workspaceFiles']`) is inject-guarded (undeclared fibers throw `without inject`), and every inject entry in this cordis is required (declaring it would gate the whole row on an optional service). `lazyFilesRemote` therefore reads `ctx.get('remote')` / `ctx.get('remote.workspaceFiles')` straight from the store, folding every lookup failure into a `gateway/internal` failure row — the verbatim `load` awaits `list` via `.then` with no `.catch`, so an escaped rejection would silently pin the level at `loading` forever. **The compile face is pinned to the dev pin too**: before `0.2.0-rc.2` `workspaceFiles.changes` takes two parameters (a session-wide watch), so `tsconfig.client.json`'s `paths` maps `@deepseek-ai/dsh-api-remotes/client` to `client-remote.d.ts` — a local declaration spelling the path-watch-era 3-argument signature — letting the verbatim `face.ts` typecheck on older matrix manifests. It is safe because the `files.actions` slot does not exist there, so the call can never execute.

**The open-in-app fork**: `src/client/open-in-app/` is a byte-for-byte fork of upstream's `ui-open-in-app` client package (baseline `d743267388` = `0.2.1-alpha.2`; file list, shim table and the sync procedure live in that directory's `FORK.md`). On promotion, re-copy per FORK.md and compare — the only permitted diff is the `.ts` suffix on the css specifier in `OpenTargetButton.tsx`; also check whether upstream's `locales.ts` `zh` key set grew (the shim's `OpenInAppKey` union must follow), whether `shared.ts` route constants changed (the devDependency version is the provenance record), and whether the `OpenInAppActionInjected` hook names drifted. The forked components spell the `*Regular` icon family: on 0.1.5/0.1.6 pixel-named runtimes no adapter is built and no button renders (same-shaped degradation, never a crash).

## 13. The B9 process-fence seam (Full-access bypass)

Across all eleven supported releases, every process surface skips `ctx.sandbox.confine()` under `danger-full-access`: the bash/pwsh executors' `execute` (plus `start` on `0.1.5/0.1.6`), `dsh-terminal-bash`'s module-private `spawnArgv`, and `dsh-ptc-runtime-node` (run_code). The subprocess spec carries no `sandboxPolicy`, so the authorization intent cannot be recovered at a lower layer — the `multi-root-process-fence` row injects a deny context through `AsyncLocalStorage`: wrapping `ctx.shell.execute` (legacy `run` / `start`) / `ctx.ptcRuntime.run` installs the context, and `ctx.subprocess.spawn` rewrites the argv only when the context is present. The only reachable PTY seam is the shared `ctx.subprocess.spawnTerminal` (the `persistent-shell` group has `isolate: terminals`, so its backend is unreachable); the session is recovered from `env.DSH_SESSION_ID` (`Agent.enter` forces `agent.id === session.id`) and resolved via `sandboxPolicy.resolve({session})`; an unresolvable session with any explicit read-only root registered fails closed. The restricted prefix never calls private runner methods: it probes `super.confine(['true'])` under a read-only policy to obtain the profile skeleton, then applies `restrictProfileArgs` (preserving the sync/async shape). See [ADR-0017](../../docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md) for the decision and `tests/process-fence.spec.ts` for the harness.

The concrete PTC `execute` helper is private; wrap public `run`. Decode a Windows UTF-16 pointee with `koffi.decode(ptr, 'char16_t', -1)`, not `str16`: the latter dereferences the first code units as another pointer and crashes natively. The old attribute candidate queries TokenSecurityAttributes with native UNICODE_STRING records; never mix these with Win32 claim PWSTR records. The runner receives a broker token handle, then verifies each root's deny-only, non-enabled group in the derived token's normal TokenGroups. A broker ACK alone is insufficient. Normal deny-only groups and the removable restricting SID list are separate lists. ADR-0020 owns installation and security boundaries; this note does not duplicate progress.

The agent-vs-user PTY discrimination is §13's only silent fail-open seam: `DSH_PTY_SESSION_ID` is stamped only on the agent PTY launch path (the panel's terminal controller stamps only `DSH_SESSION_ID`), so if a downstream release stops stamping it, agent PTYs pass through as user terminals. `src/compat/pty-marker.ts` probes the installed `@deepseek-ai/dsh-terminal-bash` build output for the constant at startup — it checks artifact content, not a version number or an in-process shape (a remotely bundled or pruned build can be verified without executing its code). A missing backend means no PTY seam and is allowed; a backend present without the marker refuses plugin load — `DSH_MULTI_ROOT_COMPAT=warn` does not relax it (warn admits an unlisted-but-coherent candidate version, not a broken contract). Tests live in `tests/pty-marker.spec.ts`.

Older Windows process binding tables may omit `GetFileType`. The fd 7 adapter fills this operation through public `extendWin32ProcessBindings`; do not assume the development pin’s table shape.
