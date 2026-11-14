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
 * The `search.*` and `settings.*` groups, plus `emptyHidden`, arrived with
 * `0.2.2-rc.2`'s workspace search and hidden-entry filtering. Every one of
 * them is read only on a host whose `workspaceFiles.search` probe passes: the
 * search UI and its settings panel never mount on an older release, so no
 * older composition is asked to resolve them.
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
  | 'emptyHidden'
  | 'truncated'
  | 'noWorkspace'
  | 'reload'
  | 'autoRefresh'
  | 'autoRefresh.enable'
  | 'autoRefresh.disable'
  | 'entry.other'
  | 'entry.noViewer'
  | 'navigator.show'
  | 'navigator.hide'
  | 'navigator.resize'
  | 'error.notFound'
  | 'error.outsideWorkspace'
  | 'error.notDirectory'
  | 'error.unavailable'
  | 'search.placeholder'
  | 'search.settings'
  | 'search.clear'
  | 'search.showHidden'
  | 'search.results'
  | 'search.empty'
  | 'search.emptyHint.hidden'
  | 'search.emptyHint.excluded'
  | 'search.emptyHint.both'
  | 'search.emptyHint.ignored'
  | 'search.emptyHint.hiddenIgnored'
  | 'search.emptyHint.excludedIgnored'
  | 'search.emptyHint.all'
  | 'search.emptyHint.label'
  | 'search.truncated'
  | 'search.incomplete'
  | 'search.failed'
  | 'search.retry'
  | 'settings.title'
  | 'settings.description'
  | 'settings.respectGitignore'
  | 'settings.add'
  | 'settings.close'
  | 'settings.restore'
  | 'settings.remove'
  | 'settings.toggle'
  | 'settings.invalid.empty'
  | 'settings.invalid.nul'
  | 'settings.invalid.absolute'
  | 'settings.invalid.parent'
  | 'settings.invalid.glob'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}
