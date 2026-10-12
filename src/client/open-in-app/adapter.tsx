/**
 * The plugin-owned wiring around the verbatim open-in-app fork.
 *
 * Upstream builds the same props in its `apply` (`directoryInjected`): one
 * controller per page, its SnapshotStores bound by the slot renderer into
 * `use*` props, and a `t` bound to the `open-in-app` namespace. This module
 * reproduces exactly that — minus slot machinery the fork never sees —
 * plus the two degradations only a fork needs:
 *
 * - the glyph set the fork spells is the `*Regular` family (0.1.7+); a
 *   pixel-name runtime (0.1.5/0.1.6) leaves the adapter undefined, so the
 *   header simply keeps the native button, mirroring upstream's own
 *   "no apps → no button" absence;
 * - `ctx.locale.bind('open-in-app')` consumes upstream's registered
 *   dictionary verbatim — same strings, upstream's updates included.
 *
 * Everything here is ours; nothing in this file needs upstream sync.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/open-in-app/adapter
 */

import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { OPEN_IN_APP_ICON_PREFIX_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { maybeIcon } from '../../compat/client-icons.ts'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionProps } from './OpenInAppAction.tsx'
import { NS } from './locales.ts'

/**
 * The props `OpenInAppAction` consumes, minus the per-render `absolutePath`
 * the switcher supplies — the shape upstream's `directoryInjected` returns.
 */
export type OpenInAppAdapter = Omit<OpenInAppActionProps, 'absolutePath'>

/**
 * Turn one observable into the renderer-bound `use*` prop shape:
 * `useSyncExternalStore` under the hood, exactly like the slot renderer's
 * own binding. Built once per store so `subscribe` stays referentially
 * stable across renders.
 * @param source - the observable to bind.
 * @returns the bound selector hook.
 */
function bindSnapshot<S>(source: ObservableSnapshot<S>): <T>(selector: (snapshot: S) => T) => T {
  const subscribe = (listener: () => void): (() => void) => source.subscribe(listener)
  const getSnapshot = (): S => source.getSnapshot()
  return function useBound<T>(selector: (snapshot: S) => T): T {
    return useSyncExternalStore(subscribe, () => selector(getSnapshot()))
  }
}

/** Glyphs the forked components spell verbatim — all `*Regular`, all probed. */
const REQUIRED_GLYPHS = [
  'IconChevronDownOutlineRegular',
  'IconRightUpOutlineRegular',
  'IconFolderOpenOutlineRegular',
  'IconWarningOutlineRegular',
] as const

/** The empty catalog stand-in when the composition carries no shortcuts service. */
const NO_SHORTCUTS: ObservableSnapshot<readonly ShortcutCatalogEntry[]> = {
  getSnapshot: () => [],
  subscribe: () => () => {},
}

/**
 * Build the open-in-app props upstream hands its own registration.
 * @param deps - the namespace-bound translate for `open-in-app`, and the
 *   composition's shortcuts catalog when it exists.
 * @returns the adapter, or `undefined` when this runtime cannot render the
 *   fork (pixel-era icon names — the forked files would crash on missing
 *   exports, so absence mirrors upstream's own no-button path).
 */
export function createOpenInAppAdapter(deps: {
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly shortcuts?: ObservableSnapshot<readonly ShortcutCatalogEntry[]> | undefined
}): OpenInAppAdapter | undefined {
  if (!REQUIRED_GLYPHS.every(name => maybeIcon([name]) !== undefined)) return undefined
  const controller = new OpenInAppController()
  void controller.load()
  return {
    useOpenInAppApps: bindSnapshot(controller.apps),
    useOpenInAppChoice: bindSnapshot(controller.choice),
    useOpenInAppLaunch: bindSnapshot(controller.operation),
    useShortcuts: bindSnapshot(deps.shortcuts ?? NO_SHORTCUTS),
    launch: (appId, path) => controller.launch(appId, path),
    choose: (appId) => { controller.choose(appId) },
    iconUrl: appId => `${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${appId}`,
    t: deps.t as OpenInAppActionProps['t'],
  }
}

export { OpenInAppAction, NS as OPEN_IN_APP_NS }
