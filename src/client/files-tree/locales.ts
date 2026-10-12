/**
 * Fork-facing shim for upstream `ui-sidebar-files/src/client/locales.ts`.
 *
 * Upstream's dictionaries stay upstream's: the runtime `sidebarFiles`
 * namespace is already registered by `@deepseek-ai/dsh-client-ui-sidebar-files`
 * in every composition where the Files tab exists, and this plugin binds that
 * same namespace instead of registering a second copy (`locale.register`
 * throws on a duplicate locale inside one namespace). What the forked
 * components still need from this file is the namespace name and the key
 * domain for `TranslateNS<typeof NS>` — copied verbatim from upstream. When
 * upstream edits copy, the string values follow automatically; only a NEW key
 * requires extending the union below.
 *
 * Sync: `SidebarFilesKey` must equal `keyof typeof zh` in upstream's
 * `locales.ts`. See FORK.md.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by upstream's plugin (verbatim). */
export const NS = 'sidebarFiles'

/** Key domain of the `sidebarFiles` namespace (verbatim union of upstream's zh keys). */
export type SidebarFilesKey =
  | 'shortcut.noSession'
  | 'type.label'
  | 'guide.title'
  | 'guide.description'
  | 'loading'
  | 'empty'
  | 'truncated'
  | 'noWorkspace'
  | 'reload'
  | 'autoRefresh'
  | 'autoRefresh.enable'
  | 'autoRefresh.disable'
  | 'entry.other'
  | 'error.notFound'
  | 'error.outsideWorkspace'
  | 'error.notDirectory'
  | 'error.unavailable'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}
