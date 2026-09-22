# The DSH compatibility contract: what an Agent needs to know first

中文：[dsh-compat-contract.md](./dsh-compat-contract.md)

This note records the compatibility machinery you must understand **before changing this repository**, because it is easy to trip over. The reasoning lives in [ADR-0009](../../docs/decisions/ADR-0009-dsh-compat-contract.md) and the operator-facing diagnosis in [the troubleshooting entry](../../docs/troubleshooting/unsupported-dsh-release.md). This note only covers what you, as an Agent, will run into.

## 1. One source of truth for the support matrix

```text
src/compat/dsh-version.ts  →  SUPPORTED_DSH_RELEASES
```

It is an array of **exact versions**, not a semver range. Currently:

```ts
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2'] as const
```

When you change it, these four must agree or `pnpm compat:check` fails:

```text
src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   the allowlist
package.json                peerDependencies         "0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2"
package.json                devDependencies          one entry of the allowlist (currently 0.1.5-rc.2)
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
```

**Do not** hand-write a signature in `src/sandbox.ts` that suits one release. Go through `widenConfined()` in `src/compat/sandbox-confine.ts`, which **preserves the shape**: a synchronous base result stays synchronous, a promise stays a promise.

Never "just wrap everything in a promise". On `0.1.5-rc.2` that would turn `ctx.sandbox.confine()` into a thenable for every caller in the composition — the bash executor, the PTY backend — which means the plugin introducing a breaking change of its own.

When reading the result in tests and smokes:

- unit tests use `confined(provider, argv, policy)` from `tests/support/confine.ts`;
- smoke scripts always `await ctx.sandbox.confine(...)`.

**This is a quiet trap**: awaiting a plain value is a no-op, but reading `.argv` off a promise yields `undefined`, and the resulting `Cannot read properties of undefined (reading 'some')` looks nothing like a version problem.

## 4. Upstream API changes may only branch inside `src/compat/`, and only structurally

Business code contains no version checks. Three adapters today:

| File | Difference it absorbs |
| --- | --- |
| `src/compat/sandbox-confine.ts` | `confine`'s sync/async shape and arity |
| `src/compat/agent-instructions.ts` | the renderer rename: `renderWorkspaceContext` (0.1.5) → `renderAgentInstructions` (0.1.6) |
| `src/compat/client-session.ts` | current session: `list.current` (0.1.5 / 0.1.6-alpha.1) → catalog row `retainedBy.mainView > 0` (0.1.6-alpha.2) |

Always probe **structurally** (is the value a thenable, which export name exists, does the snapshot carry `current`) rather than comparing version strings. Upstream is pre-stable and reshapes things within a release; a structural probe copes with that, a version comparison does not.

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

Two traps that only bite locally (CI always starts from a clean checkout):

- **That `git checkout` reverts all three files to HEAD wholesale**, taking any uncommitted edit of yours with them. Commit or stash before probing over dirty manifests.
- Once the candidate is installed, pnpm's **pre-run dependency check** decides the tree is out of sync — over the very same release-age gate — and triggers a reinstall that also fails, leaving `node_modules` half torn down (no `.bin`, a one-entry `.package-map.json`). At that point `pnpm install` cheerfully reports "Already up to date" without repairing anything, and the only way out is `rm -rf node_modules` followed by a fresh install. To avoid it, step around pnpm's script wrapper while probing: `PATH="$PWD/node_modules/.bin:$PATH"` and then run `oxlint` / `tsc` / `vitest` / `node scripts/*.mjs` directly.

## 7. The journey smoke's model endpoint speaks both wire dialects

`0.1.6-alpha.1` switched the default LLM protocol from chat completions to Messages:

```text
0.1.5-rc.2     POST {base}/chat/completions    choices[].delta, finish_reason
0.1.6-alpha.1  POST {base}/v1/messages         message_start / content_block_* / message_delta / message_stop
0.1.6-alpha.2  same dialect as 0.1.6-alpha.1 (journey 55/55, endpoint unchanged)
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
