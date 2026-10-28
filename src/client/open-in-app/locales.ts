/**
 * Fork-facing shim for upstream `ui-open-in-app/src/client/locales.ts`.
 *
 * Upstream's dictionaries stay upstream's: the runtime `open-in-app`
 * namespace is already registered by `@deepseek-ai/dsh-client-ui-open-in-app`
 * in every composition where the open-in-app feature exists, and this
 * plugin binds that same namespace instead of registering a second copy
 * (`locale.register` throws on a duplicate locale inside one namespace).
 * What the forked components still need from this file is the namespace
 * name and the key domain for `TranslateNS<typeof NS>` — copied verbatim
 * from upstream. When upstream edits copy, the string values follow
 * automatically; only a NEW key requires extending the union below.
 *
 * Sync: `OpenInAppKey` must equal `keyof typeof zh` in upstream's
 * `locales.ts`. See FORK.md.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by upstream's plugin (verbatim). */
export const NS = 'open-in-app'

/** Key domain of the `open-in-app` namespace (verbatim union of upstream's zh keys). */
export type OpenInAppKey =
  | 'open.title'
  | 'path.appDefault'
  | 'path.appsError'
  | 'shortcut.busy'
  | 'shortcut.unavailable'
  | 'open.tooltip'
  | 'path.open'
  | 'path.more'
  | 'path.reveal'
  | 'path.opened'
  | 'path.revealed'
  | 'path.openError'
  | 'path.revealError'
  | 'app.cursor'
  | 'app.vscode'
  | 'app.vscodeinsiders'
  | 'app.windsurf'
  | 'app.zed'
  | 'app.sublimetext'
  | 'app.xcode'
  | 'app.androidstudio'
  | 'app.intellij'
  | 'app.pycharm'
  | 'app.webstorm'
  | 'app.phpstorm'
  | 'app.goland'
  | 'app.rider'
  | 'app.rustrover'
  | 'app.fork'
  | 'app.sourcetree'
  | 'app.github'
  | 'app.tower'
  | 'app.gitkraken'
  | 'app.smartgit'
  | 'app.sublimemerge'
  | 'app.ghostty'
  | 'app.warp'
  | 'app.iterm'
  | 'app.kitty'
  | 'app.terminal'
  | 'app.windowsterminal'
  | 'app.gitbash'
  | 'app.gnometerminal'
  | 'app.konsole'
  | 'app.finder'
  | 'app.explorer'
  | 'app.filemanager'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-header "open workspace in application" copy (upstream declaration). */
    'open-in-app': OpenInAppKey
  }
}
