/**
 * Compatibility probe for which implementation currently serves the right
 * sidebar's `files` tab kind.
 *
 * The built-in Files page (`@deepseek-ai/dsh-client-ui-sidebar-files`) is only
 * one occupant of the tab kind: the registry ranks bands, and an `extension`
 * registration takes the kind over from the `builtin` one until it unregisters
 * (VS Code's editor-resolver rule). This plugin's root switcher lives in the
 * built-in page's `sidebar.right.tab.files.actions` seat, so a takeover makes
 * the switcher unreachable while every registration still succeeds — the
 * convergence point is the registry's effective definition, not any slot
 * declaration.
 *
 * The service is read structurally: an `unknown` service value, `get`/`subscribe`
 * looked up by name, and the definition judged by its declared band and its
 * implementation id. The built-in identity is the id counterpart of the band
 * because the id is what the body registration is keyed under; neither is
 * compared against a release string.
 *
 * ```text
 * sidebarRightTabs present, get('files') undefined      → 'absent'   (no Files page: 0.1.x, 0.2.0-rc.1)
 * get('files').priority === 'builtin' (or builtin id)   → 'builtin'
 * anything else                                         → 'shadowed' (an extension took the kind over)
 * ```
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/files-page
 */

/** The tab kind both the built-in Files page and its takeovers register under. */
export const FILES_TAB_KIND = 'files'

/** The built-in Files page's implementation identity in the tab registry. */
export const BUILTIN_FILES_TAB_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'

/** Which implementation currently serves the Files tab kind. */
export type FilesPageState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'builtin'; readonly id: string | undefined }
  | { readonly kind: 'shadowed'; readonly id: string | undefined }

/** The structural face of the tab registry this probe reads. */
interface SidebarRightTabsLike {
  readonly get?: (kind: string) => unknown
  readonly subscribe?: (listener: () => void) => unknown
}

/** The structural face of one registered tab definition. */
interface TabDefinitionLike {
  readonly id?: unknown
  readonly priority?: unknown
}

/**
 * Read one plain-object value, or `undefined` for anything else.
 * @param value - the candidate.
 * @returns the object, when the candidate is one.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as Record<string, unknown>
}

/**
 * The registry's effective definition for the Files tab kind.
 * @param tabs - the client `sidebarRightTabs` service, or whatever this composition provided under that name.
 * @returns the definition, or `undefined` when the service or the kind is absent.
 */
function effectiveFilesDefinition(tabs: unknown): Record<string, unknown> | undefined {
  const service = recordOf(tabs) as SidebarRightTabsLike | undefined
  const get = service?.get
  if (typeof get !== 'function') return undefined
  try {
    return recordOf(get.call(service, FILES_TAB_KIND))
  } catch (error) {
    // A foreign service under this name must not take the client graph down with it; an unreadable kind means "no Files page to reason about".
    void error
    return undefined
  }
}

/**
 * Which implementation is in force for the Files tab kind.
 *
 * `absent` covers both an old host without the Files page and a probe that
 * cannot read the service; callers treat both as "nothing to announce".
 * @param tabs - the client `sidebarRightTabs` service, or whatever this composition provided under that name.
 * @returns the effective implementation's state.
 */
export function filesPageState(tabs: unknown): FilesPageState {
  const definition = effectiveFilesDefinition(tabs)
  if (definition === undefined) return { kind: 'absent' }
  const id = typeof definition['id'] === 'string' ? definition['id'] : undefined
  const priority = (definition as TabDefinitionLike).priority
  // The id is the fallback for a release that stops naming the band on the
  // built-in definition; the registry rejects a duplicate id, so it can only
  // be the built-in registration.
  if (priority === 'builtin' || id === BUILTIN_FILES_TAB_ID) return { kind: 'builtin', id }
  return { kind: 'shadowed', id }
}

/**
 * Observe tab-registry changes, when this release exposes the subscription.
 * @param tabs - the client `sidebarRightTabs` service, or whatever this composition provided under that name.
 * @param listener - called after each registration or removal.
 * @returns the unsubscribe callback; a no-op where the release has none.
 */
export function subscribeFilesPage(tabs: unknown, listener: () => void): () => void {
  const service = recordOf(tabs) as SidebarRightTabsLike | undefined
  const subscribe = service?.subscribe
  if (typeof subscribe !== 'function') return () => {}
  const dispose = subscribe.call(service, listener)
  return typeof dispose === 'function' ? (dispose as () => void) : () => {}
}
