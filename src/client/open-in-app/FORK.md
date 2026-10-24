# open-in-app fork — provenance and sync

This directory is a **verbatim fork** of upstream's
`@deepseek-ai/dsh-client-ui-open-in-app` client package, taken to give the
additional-root Files header the *same* open-in-application split button the
native one shows — because the upstream occupant always receives the primary
root through its slot props and cannot be re-pointed.

- **Source**: `deepseek-harness/packages/client/ui-open-in-app/src/client/`
- **Revision**: `1f81c047fc` (release `0.2.1-rc.3`, 2026-10-23) — matches
  this package's dev pin and the `@deepseek-ai/dsh-host-open-in-app`
  devDependency, which is the machine-readable record of the fork base.
  The upstream `src/client/` tree did not change between `0.2.1-alpha.2`
  (`d743267388`) and `0.2.1-rc.3`, so the fork files below remain
  byte-identical without a re-copy.

## Verbatim files (copy-diff must stay empty)

| File | Delta vs upstream |
| --- | --- |
| `OpenInAppAction.tsx` | none — byte-identical |
| `OpenTargetButton.tsx` | one line: the css specifier gains `.ts` (`'./OpenTargetButton.module.css.ts'`) because this toolchain resolves real files, not CSS-module virtual modules |
| `controller.ts` | none — byte-identical |
| `applications.ts` | none — byte-identical |
| `open-failure-toast.tsx` | none — byte-identical |
| `OpenTargetButton.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-open*` |

## Shim files (ours — replace what cannot resolve or must not duplicate)

| File | Stands in for | Why |
| --- | --- | --- |
| `OpenTargetButton.module.css.ts` | the css-module virtual module | exports the same `css.<name>` map → `mrfw-open*` classes; rules live in styles.ts |
| `locales.ts` | upstream `locales.ts` | only `NS` + the `OpenInAppKey` union + the `LocaleNamespaceMap` augmentation; dictionaries are NOT re-registered — the adapter binds upstream's live `open-in-app` namespace so strings track upstream automatically |
| `open-path.ts` | upstream `open-path.ts` | only the `OpenInAppPathFailure` union; upstream's `OpenInAppPathController` speaks to a Session Remote this plugin does not hold and nothing here calls it |
| `ambient.d.ts` | `dsh-client-shortcuts/client` types | type-only import; the runtime catalog is soft-probed in the adapter |
| `upstream-surface.d.ts` | the primitives exports the pinned revision spells | declares the `*Regular` glyph consts and a `shortcutKeys`-aware `Tooltip` overload so the verbatim named imports resolve on pixel-era manifests too; types only — runtime stays gated by the adapter |
| `adapter.tsx` | upstream `apply`'s `directoryInjected` | our wiring: controller singleton, snapshot→hook binding, `useShortcuts` soft-probe, `bind('open-in-app')`, the `*Regular` glyph gate for 0.1.x pixel-name runtimes, and the icon route through `compat/open-in-app-routes` (whose `*_ROUTE` spelling likewise postdates the pixel era) |
| `FORK.md` | — | this file |

## Sync procedure (when the dev pin moves)

1. `cp` the six verbatim files from the upstream checkout at the new pin.
2. Re-apply the one-line css-specifier edit in `OpenTargetButton.tsx`
   (`'./OpenTargetButton.module.css'` → `'./OpenTargetButton.module.css.ts'`).
3. `diff` each file against upstream — the only accepted difference is that
   line. Anything else means upstream moved: port the change instead of
   resolving the diff by hand.
4. Diff `OpenTargetButton.module.css` — copy changed rules into
   `styles.ts`'s `mrfw-open*` block keeping the rename.
5. Diff upstream `locales.ts`'s `zh` key set — extend `OpenInAppKey` for new
   keys (strings themselves are consumed live from upstream's namespace).
6. Re-check `OpenInAppActionInjected`'s hook names against `adapter.tsx`.
