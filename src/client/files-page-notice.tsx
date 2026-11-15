/**
 * The Files-page takeover notice.
 *
 * The built-in Files page hosts this plugin's root switcher in its header; a
 * third-party extension that takes the `files` tab kind over replaces that
 * page, so the switcher is registered and never rendered. Nothing in the slot
 * system reports that: the seat simply never mounts. This module watches the
 * tab registry's effective definition instead and announces the takeover once
 * with the official `Toast`, at the lowest level the primitive offers — plain
 * text, no warning glyph — so the user learns why the switcher is missing
 * without the plugin pretending the situation is an error.
 *
 * The notice is informational: it grants nothing, stores nothing, and calls no
 * host endpoint. The footer's Workspace Folders action keeps managing roots
 * while the takeover lasts.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-page-notice
 */

import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { filesPageState, subscribeFilesPage, type FilesPageState } from '../compat/files-page.ts'
import type { Key } from './locales.ts'

/** How long the takeover notice stays at full opacity before it fades out. */
export const FILES_PAGE_NOTICE_HOLD_MS = 5000

/** One announcement; `seq` keys the banner so a repeated takeover restarts it. */
export interface FilesPageNoticeState {
  /** Monotonic show sequence; the component remounts the Toast on a new value. */
  readonly seq: number
}

/** Store the detector reports into and the overlay entry reads. */
export interface FilesPageNoticeSource {
  /** Current notice for the overlay entry, or null while none shows. */
  readonly hooks: { readonly notice: HostObservable<FilesPageNoticeState | null> }
  /** Announce one takeover. */
  readonly report: () => void
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/**
 * Copy the notice renders, bound to this plugin's dictionary.
 *
 * A one-parameter face: the notice carries no placeholder.
 */
export type FilesPageNoticeTranslate = (key: Key) => string

/** The injected business face of the overlay entry. */
export interface FilesPageNoticeInjected {
  /** Notice store, bound by the slot renderer as `useNotice`. */
  readonly hooks: { readonly notice: HostObservable<FilesPageNoticeState | null> }
  /** Unmount the current notice. */
  readonly dismiss: () => void
  /** Localized copy for this plugin's namespace. */
  readonly t: FilesPageNoticeTranslate
}

/** Props of the `shell.overlay` entry. */
export type FilesPageNoticeProps = PropsRuntime<'shell.overlay'> & InjectFace<FilesPageNoticeInjected>

/**
 * Create the notice store the overlay entry renders.
 * @returns the observable notice with its report and dismiss actions.
 */
export function createFilesPageNoticeSource(): FilesPageNoticeSource {
  const store = createSnapshotStore<FilesPageNoticeState | null>(null)
  let seq = 0
  return {
    hooks: { notice: store },
    report: () => {
      seq += 1
      store.set({ seq })
    },
    dismiss: () => { store.set(null) },
  }
}

/**
 * Render the current takeover notice as the official transient Toast.
 *
 * No `icon` and no `tone`: the primitive's icon seat carries the warning tint,
 * so omitting it is what makes this an informational notice rather than a
 * warning. `onDone` fires once the fade completes; the source drops the state.
 * @param props - the notice hook, its dismissal, and the locale seat.
 * @returns the banner on display, or null.
 */
export function FilesPageNoticeToast({ useNotice, dismiss, t }: FilesPageNoticeProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  return <Toast
    key={`files-page-notice-${String(notice.seq)}`}
    text={t('filesPage.notice')}
    holdMs={FILES_PAGE_NOTICE_HOLD_MS}
    onDone={dismiss}
  />
}

/**
 * Wire the takeover detector and its overlay entry into the client root.
 *
 * The detector waits for `sidebarRightTabs` rather than requiring it: a
 * composition without the right sidebar, or a release before the Files page
 * existed, simply never starts it. Each evaluation announces at most one
 * takeover per effective implementation id — a continuing takeover does not
 * repeat the notice, and a restore rearms it so a later takeover announces
 * again.
 * @param ctx - the client root context.
 * @param source - the notice store the overlay entry renders.
 * @param t - copy bound to this plugin's dictionary.
 */
export function installFilesPageNotice(
  ctx: ClientContext,
  source: FilesPageNoticeSource,
  t: FilesPageNoticeTranslate,
): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'multi-root-files-page.notice',
    inject: () => ({ hooks: source.hooks, dismiss: source.dismiss, t }),
  }, FilesPageNoticeToast))

  ctx.inject(['sidebarRightTabs'], scope => {
    const tabs: unknown = scope.get('sidebarRightTabs')
    let announced: string | undefined
    const evaluate = (): void => {
      const state: FilesPageState = filesPageState(tabs)
      if (state.kind === 'shadowed') {
        const id = state.id ?? 'unknown'
        if (announced === id) return
        announced = id
        source.report()
        return
      }
      announced = undefined
    }
    scope.effect(() => {
      const unsubscribe = subscribeFilesPage(tabs, evaluate)
      evaluate()
      return unsubscribe
    }, 'multi-root-workspace: files-page takeover notice')
  })
}
