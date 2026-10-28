# open-in-app fork — provenance and sync

This directory is a **verbatim fork** of upstream's
`@deepseek-ai/dsh-client-ui-open-in-app` client package, taken to give the
additional-root Files header the *same* open-in-application split button the
native one shows — because the upstream occupant always receives the primary
root through its slot props and cannot be re-pointed.

- **Source**: `deepseek-harness/packages/client/ui-open-in-app/src/client/`
- **Revision**: `f3803c9697` (release `0.2.2-alpha.2`, 2026-10-27) — matches
  this package's dev pin and the `@deepseek-ai/dsh-host-open-in-app`
  devDependency, which is the machine-readable record of the fork base.
  Between `0.2.1-rc.3` (`1f81c047fc`) and `0.2.2-alpha.2` the upstream
  `src/client/` tree moved gesture feedback off the control and onto a
  `shell.overlay` seat: `OpenTargetButton` takes a `report` prop
  (`OpenTargetReporter`) and its `execute` resolves an `OpenInAppOutcome`
  instead of rejecting, `controller.ts`'s `launch` resolves
  `{kind:'opened'}`/`{kind:'skipped'}`/`{kind:'failed','openError'}`,
  `open-failure-toast.tsx` was deleted in favor of the new `open-toast.tsx`
  (toast source + `OpenInAppToast` overlay entry), `outcome.ts` was added,
  `OpenTargetButton.module.css` wrapped its hover rules in
  `@media (hover: hover)`, and `locales.ts` gained the `path.opened` /
  `path.revealed` keys. Upstream also added path/deliverable consumers
  (`OpenPathAction.tsx`, `OpenPathEmptyAction.tsx`, `FileRouteAction.tsx`,
  `file-applications.ts`, its own `open-path.ts` controller) which this
  fork does not copy — the switcher only mounts the directory control.

## Verbatim files (copy-diff must stay empty)

| File | Delta vs upstream |
| --- | --- |
| `OpenInAppAction.tsx` | none — byte-identical |
| `OpenTargetButton.tsx` | one line: the css specifier gains `.ts` (`'./OpenTargetButton.module.css.ts'`) because this toolchain resolves real files, not CSS-module virtual modules |
| `controller.ts` | none — byte-identical |
| `applications.ts` | none — byte-identical |
| `open-toast.tsx` | two lines: the css-specifier-style deltas this toolchain needs — the type-only `'@deepseek-ai/dsh-client-ui-layout/client'` side-effect import is dropped (that package is not a devDependency here; the `shell.overlay` slot type still resolves through the host's own graph), and `isMobileDevice` comes from `./device.ts` instead of the primitives import it joined only in `0.2.2-alpha.2` |
| `OpenTargetButton.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-open*` |

## Shim files (ours — replace what cannot resolve or must not duplicate)

| File | Stands in for | Why |
| --- | --- | --- |
| `OpenTargetButton.module.css.ts` | the css-module virtual module | exports the same `css.<name>` map → `mrfw-open*` classes; rules live in styles.ts |
| `locales.ts` | upstream `locales.ts` | only `NS` + the `OpenInAppKey` union + the `LocaleNamespaceMap` augmentation; dictionaries are NOT re-registered — the adapter binds upstream's live `open-in-app` namespace so strings track upstream automatically |
| `outcome.ts` | upstream `outcome.ts` | only the `OpenInAppPathFailure`/`OpenInAppOutcome` unions; upstream spells them as aliases of `dsh-client-ui-deliverables`' `PresentedOpen*` types — this shim spells the same structures verbatim because that package is not a devDependency |
| `open-path.ts` | upstream `open-path.ts` | re-exports `OpenInAppPathFailure` from `outcome.ts`, matching upstream's split; upstream's `OpenInAppPathController` speaks to a Session Remote this plugin does not hold and nothing here calls it |
| `device.ts` | `isMobileDevice` in the primitives import upstream's `open-toast.tsx` spells | the export exists only from `0.2.2-alpha.2`, so the shim probes it by export name (`import * as primitives`, the `compat/client-icons.ts` pattern) and falls back to the identical userAgent/MacIntel-touch logic on older releases; memoized like upstream's |
| `ambient.d.ts` | `dsh-client-shortcuts/client` types | type-only import; the runtime catalog is soft-probed in the adapter |
| `upstream-surface.d.ts` | the primitives exports the pinned revision spells | declares the `*Regular` glyph consts and a `shortcutKeys`-aware `Tooltip` overload so the verbatim named imports resolve on pixel-era manifests too; types only — runtime stays gated by the adapter |
| `adapter.tsx` | upstream `apply`'s `directoryInjected` | our wiring: controller singleton, snapshot→hook binding, `useShortcuts` soft-probe, `bind('open-in-app')`, the `*Regular` glyph gate for 0.1.x pixel-name runtimes, the icon route through `compat/open-in-app-routes` (whose `*_ROUTE` spelling likewise postdates the pixel era), and one `createOpenInAppToastSource()` per adapter whose `report` joins the returned face while `hooks`/`dismiss` feed the plugin's own `shell.overlay` registration in `src/client/index.ts` |
| `FORK.md` | — | this file |

## Sync procedure (when the dev pin moves)

1. `cp` the verbatim files (`OpenInAppAction.tsx`, `OpenTargetButton.tsx`,
   `controller.ts`, `applications.ts`, `OpenTargetButton.module.css`,
   `open-toast.tsx`) from the upstream checkout at the new pin; delete any
   file upstream deleted (e.g. `open-failure-toast.tsx`).
2. Re-apply the one-line css-specifier edit in `OpenTargetButton.tsx`
   (`'./OpenTargetButton.module.css'` → `'./OpenTargetButton.module.css.ts'`)
   and `open-toast.tsx`'s two deltas (drop the layout side-effect import;
   `isMobileDevice` from `./device.ts`).
3. `diff` each file against upstream — the only accepted differences are
   those lines. Anything else means upstream moved: port the change instead
   of resolving the diff by hand.
4. Diff `OpenTargetButton.module.css` — copy changed rules into
   `styles.ts`'s `mrfw-open*` block keeping the rename.
5. Diff upstream `locales.ts`'s `zh` key set — extend `OpenInAppKey` for new
   keys (strings themselves are consumed live from upstream's namespace).
6. Re-check `OpenInAppActionInjected`'s hook names (and `OpenTargetReporter`)
   against `adapter.tsx`, and the `PresentedOpen*` unions upstream's
   `outcome.ts` aliases against the fork's `outcome.ts` shim.
