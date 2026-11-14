/**
 * The additional-root Files pane: a listed tree, and — where the host exposes
 * workspace search — the search bar, its results, and the search preferences
 * that both follow.
 *
 * Upstream keeps this split inside `FileNavigator`: the navigator draws the
 * bar, the status line, the tree or the results, and the settings popover, all
 * from one pane record. The fork needs the same split for a different reason:
 * the tree itself is a byte-identical copy (FORK.md), so everything the search
 * adds lives here, beside it, and `FilesTree` only learns what to draw.
 *
 * Behavior is upstream's, deliberately: every non-blank keystroke searches and
 * aborts the previous one, a blank query ends the search and draws the tree
 * again, a settled result starts fully expanded at its top, the bar and the
 * result offset survive a body remount through the inject product, and the
 * preferences are read per workspace root and re-run the search when they
 * change. What cannot be reproduced — the native Files shortcut focusing the
 * hidden native field — is a documented boundary (see the plan / README).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/pane
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type ReactNode,
} from 'react'
import clsx from 'clsx'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { maybeComponent, maybeIcon } from '../../compat/client-icons.ts'
import type { NativeTreeRenderer } from '../../compat/files-tree.ts'
import type { FilesTreeSurface, FilesTreeSearchSeat } from './adapter.tsx'
import type { FilesTreeProps } from './FilesTree.tsx'
import { FilesTree } from './FilesTree.tsx'
import {
  addRule, defaultRules, defaultSearchPreferences, enabledPaths, isDefaultRules, removeRule, setRuleEnabled,
  type ExclusionRule, type RuleInvalidReason, type WorkspaceSearchPreferences,
} from './search-rules.ts'
import { buildSearchTree } from './search-tree.ts'
import {
  searchRequestKey, type SearchFailureInfo, type SearchPaneState, type SearchPaneStates, type SearchResultView,
} from './search-state.ts'
import type { FilesTabState } from './store.ts'
import { TreeView } from './tree-view.tsx'

/**
 * The host components and glyphs the search surface draws, probed by export
 * name rather than imported by name.
 *
 * The pane only ever mounts behind the `workspaceFiles.search` probe
 * (`0.2.2-rc.2`), where all of them exist. The probe keeps this module's
 * import graph — and therefore the type check of older supported pins, where
 * several names do not exist — clean, without a module augmentation: an
 * augmentation file next to `open-in-app`'s is not reliably merged by the
 * older pins' declaration graph, and the paint-time probe is the pattern this
 * package already uses for every other version-dependent primitive.
 */
const IconSearch = maybeIcon(['IconSearchOutlineRegular'])
const IconEye = maybeIcon(['IconEyeOutlineRegular'])
const IconEyeOff = maybeIcon(['IconEyeOffOutlineRegular'])
const IconClose = maybeIcon(['IconCloseOutlineRegular'])
const IconInfo = maybeIcon(['IconInfoOutlineRegular'])
const IconPlus = maybeIcon(['IconPlusOutlineRegular'])
const IconTrash = maybeIcon(['IconTrashOutlineRegular'])
const IconRefresh = maybeIcon(['IconRefreshOutlineRegular'])

/** The Tooltip props the pane spells; the pane never mounts without a Tooltip. */
interface TipProps {
  readonly label: string
  readonly side?: 'right' | 'bottom' | 'top' | 'left' | undefined
  readonly delayMs?: number | undefined
  readonly maxWidth?: number | undefined
  readonly portal?: boolean | undefined
  readonly openOnClick?: boolean | undefined
  readonly children: ReactNode
}

const HostTip = maybeComponent<(props: TipProps) => ReactNode>(['Tooltip'])

/** A Tooltip where the host has one, and the bare trigger where it does not. */
function Tip(props: TipProps): ReactNode {
  if (HostTip === undefined) return props.children
  return <HostTip {...props} />
}

/** The host Button props the pane spells, plus the `data-*` hooks its tests read. */
interface PaneButtonProps {
  readonly variant?: 'primary' | 'ghost' | 'outline' | 'toolbar' | undefined
  readonly size?: 'sm' | 'md' | undefined
  readonly className?: string | undefined
  readonly 'aria-label'?: string | undefined
  readonly onClick?: (() => void) | undefined
  readonly children?: ReactNode
  readonly [key: `data-${string}`]: string | undefined
}

const HostButton = maybeComponent<(props: PaneButtonProps) => ReactNode>(['Button'])

/** A host Button where the host has one, and the equivalent native button where it does not. */
function PaneButton(props: PaneButtonProps): ReactNode {
  if (HostButton !== undefined) return <HostButton {...props} />
  return (
    <button type="button" className={props.className} aria-label={props['aria-label']} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

/** The in-flight dot props the pane spells. */
interface PaneStateDotProps {
  readonly state: 'ongoing'
  readonly size?: number | undefined
  readonly className?: string | undefined
}

const HostStateDot = maybeComponent<(props: PaneStateDotProps) => ReactNode>(['StateDot'])

/** The blank preferences a composition without a preference source reads. */
const NO_PREFERENCES: WorkspaceSearchPreferences = defaultSearchPreferences()

/** The selector hook a composition without the search seat reads: always "nothing". */
const NO_SEARCH_STATES: SnapshotSelectorHook<SearchPaneStates> = selector => selector({})

/** The plugin-stylesheet classes the search UI wears. */
const CLASS = {
  pane: 'mrfw-fsPane',
  bar: 'mrfw-fsBar',
  field: 'mrfw-fsField',
  tool: 'mrfw-fsTool',
  input: 'mrfw-fsInput',
  status: 'mrfw-fsStatus',
  statusIdle: 'mrfw-fsStatusIdle',
  statusLine: 'mrfw-fsStatusLine',
  spinner: 'mrfw-fsSpinner',
  failure: 'mrfw-fsFailure',
  retry: 'mrfw-fsRetry',
  emptyNote: 'mrfw-fsEmptyNote',
  infoButton: 'mrfw-fsInfoBtn',
  settings: 'mrfw-fsSettings',
  settingsHeader: 'mrfw-fsSettingsHeader',
  settingsTitle: 'mrfw-fsSettingsTitle',
  settingsDesc: 'mrfw-fsSettingsDesc',
  settingsError: 'mrfw-fsSettingsError',
  settingsOption: 'mrfw-fsSettingsOption',
  rules: 'mrfw-fsRules',
  rule: 'mrfw-fsRule',
  ruleOff: 'mrfw-fsRuleOff',
  ruleLabel: 'mrfw-fsRuleLabel',
  ruleCheck: 'mrfw-fsRuleCheck',
  ruleName: 'mrfw-fsRuleName',
  ruleInput: 'mrfw-fsRuleInput',
  addRule: 'mrfw-fsAddRule',
  toolBtn: 'mrfw-fsToolBtn',
  icon: 'mrfw-fsIcon',
} as const

/**
 * Fold one rejected search into the pane's failure vocabulary.
 * @param error - the rejection, normally a `PanelError` with a stable code.
 * @returns the code the panel localizes and its fallback text.
 */
function failureOf(error: unknown): SearchFailureInfo {
  const record = error as { readonly code?: unknown; readonly message?: unknown } | null | undefined
  if (typeof record?.code === 'string') {
    return { code: record.code, message: typeof record.message === 'string' ? record.message : '' }
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Localize a failed search's fallback text in the tree's own vocabulary, for
 * the codes the sidebar-files namespace owns.
 * @param t - namespace-bound translate.
 * @param failure - the failed search's code and fallback text.
 * @returns the localized failure line.
 */
function describeTreeFailure(t: TranslateNS<'sidebarFiles'>, failure: SearchFailureInfo): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    default: return t('error.unavailable', { message: failure.message })
  }
}

/** Why an empty result may still hide matches. */
type EmptyHint =
  | 'search.emptyHint.all'
  | 'search.emptyHint.both'
  | 'search.emptyHint.hiddenIgnored'
  | 'search.emptyHint.hidden'
  | 'search.emptyHint.excludedIgnored'
  | 'search.emptyHint.excluded'
  | 'search.emptyHint.ignored'

/**
 * Why an empty result may still hide matches.
 * @param result - a settled search with no matches.
 * @returns the hint's locale key, or `undefined` when the search left nothing out.
 */
function emptyHint(result: Extract<SearchResultView, { kind: 'found' }>): EmptyHint | undefined {
  const hidden = result.hiddenLeftOut
  const excluded = result.excluded
  const ignored = result.ignored
  if (hidden && excluded) return ignored ? 'search.emptyHint.all' : 'search.emptyHint.both'
  if (hidden) return ignored ? 'search.emptyHint.hiddenIgnored' : 'search.emptyHint.hidden'
  if (excluded) return ignored ? 'search.emptyHint.excludedIgnored' : 'search.emptyHint.excluded'
  return ignored ? 'search.emptyHint.ignored' : undefined
}

/**
 * Move keyboard focus one step along the search field and the drawn rows.
 * @param event - a key pressed inside the pane.
 */
function moveAlongRows(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return
  if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(
    '[data-mrfw-files-search], [data-mrfw-files-results] li[data-files-entry] > button, [data-mrfw-files-results] li[data-files-entry] > div > button',
  )]
  const at = stops.findIndex(stop => stop === event.target)
  const next = at === -1 ? undefined : stops[at + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next === undefined) return
  event.preventDefault()
  next.focus()
}

/**
 * What the results area shows below the result tree.
 * @param props.result - a settled search with its matches drawn.
 * @param props.t - namespace-bound translate.
 * @returns the notes under the result tree.
 */
function SearchNotes({ result, t }: {
  readonly result: Extract<SearchResultView, { kind: 'found' }>
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const hint = result.count > 0 ? undefined : emptyHint(result)
  return (
    <>
      {result.count === 0 && (
        <p className={clsx('mrfw-ftNote', CLASS.emptyNote)} data-files-row="search-empty">
          <span>{t('search.empty')}</span>
          {hint !== undefined && (
            <Tip label={t(hint)} side="bottom" delayMs={300} maxWidth={300} portal openOnClick>
              <PaneButton variant="ghost" size="sm" className={CLASS.infoButton} aria-label={t('search.emptyHint.label')} data-files-search-hint>
                {IconInfo !== undefined && <IconInfo size={11} aria-hidden="true" />}
              </PaneButton>
            </Tip>
          )}
        </p>
      )}
      {result.truncated && <p className="mrfw-ftNote" data-files-row="search-truncated">{t('search.truncated', { count: String(result.count) })}</p>}
      {result.incomplete && <p className="mrfw-ftNote" data-files-row="search-incomplete">{t('search.incomplete')}</p>}
    </>
  )
}

/**
 * What the results area shows for a search the Host could not run.
 * @param props.failure - the failed search's failure.
 * @param props.onRetry - runs the same query again.
 * @param props.t - namespace-bound translate.
 * @returns the failure notice.
 */
function SearchFailure({ failure, onRetry, describe, t }: {
  readonly failure: SearchFailureInfo
  readonly onRetry: () => void
  /** The plugin-level localization for panel codes, or `undefined` for the tree's own. */
  readonly describe?: ((failure: SearchFailureInfo) => string | undefined) | undefined
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const message = describe?.(failure) ?? describeTreeFailure(t, failure)
  return (
    <div className={CLASS.failure} data-files-row="search-failed">
      <p className="mrfw-ftNote" role="alert">{t('search.failed', { message })}</p>
      <PaneButton variant="outline" size="sm" className={CLASS.retry} data-files-search-retry onClick={onRetry}>{t('search.retry')}</PaneButton>
    </div>
  )
}

/** One rule row of the settings list. */
function RuleRow({ rule, enabled, onToggle, onRemove, t }: {
  readonly rule: ExclusionRule
  readonly enabled: boolean
  readonly onToggle: (enabled: boolean) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  return (
    <li className={clsx(CLASS.rule, !enabled && CLASS.ruleOff)} data-files-rule={rule.path}>
      <label className={CLASS.ruleLabel}>
        <input type="checkbox" className={CLASS.ruleCheck} checked={enabled}
          aria-label={t('settings.toggle', { path: rule.path })}
          onChange={(event) => { onToggle(event.target.checked) }} />
        <span className={CLASS.ruleName}>{rule.path}</span>
      </label>
      <Tip label={t('settings.remove', { path: rule.path })} side="bottom" portal>
        <button type="button" className={CLASS.toolBtn} aria-label={t('settings.remove', { path: rule.path })} onClick={onRemove}>
          {IconTrash !== undefined && <IconTrash />}
        </button>
      </Tip>
    </li>
  )
}

/**
 * The search settings popover: the exclusion rules and the ignore-file choice.
 * A rule change is a draft until the panel closes; the ignore-file choice saves
 * at once, as upstream's does.
 */
function SearchSettings({ rules, respectGitignore, onRules, onRespectGitignore, onClose, t }: {
  readonly rules: readonly ExclusionRule[]
  readonly respectGitignore: boolean
  readonly onRules: (rules: readonly ExclusionRule[]) => void
  readonly onRespectGitignore: (respectGitignore: boolean) => void
  readonly onClose: (refocus: boolean) => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState<RuleInvalidReason | undefined>(undefined)
  const add = useRef<HTMLInputElement | null>(null)
  const keepFocus = (): void => { add.current?.focus() }
  return (
    <section
      className={CLASS.settings}
      role="dialog"
      aria-label={t('settings.title')}
      tabIndex={-1}
      data-files-search-settings
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        onClose(false)
      }}
    >
      <div className={CLASS.settingsHeader}>
        <span className={CLASS.settingsTitle}>{t('settings.title')}</span>
        {!isDefaultRules(rules) && (
          <Tip label={t('settings.restore')} side="bottom" portal>
            <button type="button" className={CLASS.toolBtn} aria-label={t('settings.restore')} data-files-settings-restore
              onClick={() => { keepFocus(); onRules(defaultRules()) }}>
              {IconRefresh !== undefined && <IconRefresh />}
            </button>
          </Tip>
        )}
        <Tip label={t('settings.close')} side="bottom" portal>
          <button type="button" className={CLASS.toolBtn} aria-label={t('settings.close')} onClick={() => { onClose(true) }}>
            {IconClose !== undefined && <IconClose />}
          </button>
        </Tip>
      </div>
      <p className={CLASS.settingsDesc}>{t('settings.description')}</p>
      <div className={clsx(CLASS.rule, CLASS.settingsOption)}>
        <label className={CLASS.ruleLabel}>
          <input type="checkbox" className={CLASS.ruleCheck} checked={respectGitignore} data-files-respect-gitignore
            onChange={(event) => { onRespectGitignore(event.target.checked) }} />
          <span className={CLASS.ruleName}>{t('settings.respectGitignore')}</span>
        </label>
      </div>
      <div className={clsx(CLASS.rule, CLASS.addRule)}>
        {IconPlus !== undefined && <IconPlus className={CLASS.icon} />}
        <input
          ref={add}
          className={CLASS.ruleInput}
          type="text"
          value={text}
          placeholder={t('settings.add')}
          aria-label={t('settings.add')}
          aria-invalid={invalid !== undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(event) => { setText(event.target.value); setInvalid(undefined) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const added = addRule(rules, text)
            if (added.kind === 'invalid') { setInvalid(added.reason); return }
            onRules(added.rules)
            setText('')
          }}
        />
      </div>
      {invalid !== undefined && <p className={CLASS.settingsError} role="alert">{t(`settings.invalid.${invalid}` as never)}</p>}
      <ul className={CLASS.rules}>
        {rules.map(rule => (
          <RuleRow
            key={rule.path}
            rule={rule}
            enabled={rule.enabled}
            onToggle={(enabled) => { onRules(setRuleEnabled(rules, rule.path, enabled)) }}
            onRemove={() => { keepFocus(); onRules(removeRule(rules, rule.path)) }}
            t={t}
          />
        ))}
      </ul>
    </section>
  )
}

/** The search bar: settings, field, hidden-entry toggle, and clear. */
function SearchBar({ query, showHidden, inputRef, onQuery, onShowHidden, onSettings, settingsOpen, t }: {
  readonly query: string
  readonly showHidden: boolean
  readonly inputRef: (element: HTMLInputElement | null) => void
  readonly onQuery: (query: string) => void
  readonly onShowHidden: (showHidden: boolean) => void
  readonly onSettings: () => void
  readonly settingsOpen: boolean
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  return (
    <div className={CLASS.bar}>
      <div className={CLASS.field}>
        <Tip label={t('search.settings')} side="bottom" portal>
          <button type="button" className={clsx(CLASS.toolBtn, CLASS.tool)} aria-label={t('search.settings')}
            aria-haspopup="dialog" aria-expanded={settingsOpen} data-files-search-settings-toggle
            onMouseDown={(event) => { if (settingsOpen) event.preventDefault() }}
            onClick={onSettings}>
            {IconSearch !== undefined && <IconSearch />}
          </button>
        </Tip>
        <input
          ref={inputRef}
          className={CLASS.input}
          type="search"
          value={query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          autoComplete="off"
          spellCheck={false}
          data-mrfw-files-search
          onChange={(event) => { onQuery(event.target.value) }}
        />
        <Tip label={t('search.showHidden')} side="bottom" portal>
          <button type="button" className={clsx(CLASS.toolBtn, CLASS.tool)} aria-pressed={showHidden}
            aria-label={t('search.showHidden')} data-files-show-hidden
            onClick={() => { onShowHidden(!showHidden) }}>
            {showHidden ? (IconEye !== undefined && <IconEye />) : (IconEyeOff !== undefined && <IconEyeOff />)}
          </button>
        </Tip>
        {query !== '' && (
          <Tip label={t('search.clear')} side="bottom" portal>
            <button type="button" className={clsx(CLASS.toolBtn, CLASS.tool)} aria-label={t('search.clear')} data-files-search-clear
              onClick={() => { onQuery('') }}>
              {IconClose !== undefined && <IconClose />}
            </button>
          </Tip>
        )}
      </div>
    </div>
  )
}

/** The result tree: the same tree drawing, with matches highlighted and its own expansion. */
function ResultTree({ result, expanded, filesTree, nativeTree, onToggle, onOpen }: {
  readonly result: Extract<SearchResultView, { kind: 'found' }>
  readonly expanded: readonly string[]
  readonly filesTree: FilesTreeSurface
  readonly nativeTree: NativeTreeRenderer | undefined
  readonly onToggle: (path: string) => void
  /** Open one result row by its absolute path. */
  readonly onOpen: (path: string) => void
}): ReactNode {
  const tree: FilesTabState = { ...result.tree, expanded: [...expanded] }
  return (
    <TreeView
      state={tree}
      t={filesTree.t}
      sessionId={filesTree.sessionId}
      nativeTree={nativeTree}
      menu={filesTree.menu}
      canOpen={filesTree.canOpen}
      highlight={result.query}
      unmatched
      onToggle={(_parent, path) => { onToggle(path) }}
      onOpen={onOpen}
    />
  )
}

/** One pane's additional-root body: the search bar, the results or the tree, and the settings. */
export interface FilesPaneProps {
  /** The assembled surface: store, faces, menus, viewer registry, and the search seat. */
  readonly filesTree: FilesTreeSurface
  /** The `(tab, root)` search record key. */
  readonly stateKey: string
  /** The selected root's registry id — what the search endpoint takes. */
  readonly rootId: string
  readonly tabId: TabId
  readonly root: string
  readonly signal: AbortSignal
  readonly useStore: FilesTreeProps['useStore']
  readonly actions: FilesTreeProps['actions']
  readonly onOpenFile: (address: string) => void
  readonly nativeTree?: NativeTreeRenderer | undefined
  readonly reveal?: FilesTreeProps['reveal']
  readonly saved?: FilesTreeProps['saved']
  readonly onScrollOffset?: ((offset: number) => void) | undefined
  /** The plugin-level localization for a panel failure code (`error.search-unavailable`, …). */
  readonly describeFailure?: ((failure: SearchFailureInfo) => string | undefined) | undefined
}

/**
 * Draw the pane: a plain listed tree without the search seat, or the search bar
 * and its results where the host exposes the feature.
 * @param props - the tree's inputs plus the selected root's search key.
 * @returns the pane's body.
 */
export function FilesPane(props: FilesPaneProps): ReactNode {
  const {
    filesTree, stateKey, rootId, root, tabId, signal, useStore, actions, onOpenFile, nativeTree, reveal, saved,
    onScrollOffset, describeFailure,
  } = props
  const search: FilesTreeSearchSeat | undefined = filesTree.search
  // Hook order must not depend on the seat: the composition decides once,
  // but the takeover's first render may still be resolving.
  const useSearchState = search?.useSearchState ?? NO_SEARCH_STATES
  const state: SearchPaneState | undefined = useSearchState(states => states[stateKey])
  const preferencesSource = search?.preferences.source(root)
  const subscribePreferences = useCallback(
    (notify: () => void): (() => void) => preferencesSource?.subscribe(notify) ?? (() => {}),
    [preferencesSource],
  )
  const preferences = useSyncExternalStore(
    subscribePreferences,
    () => preferencesSource?.getSnapshot() ?? NO_PREFERENCES,
  )
  const store = search?.store
  const run = search?.run
  const query = state?.query ?? ''
  const trimmed = query.trim()
  const barOpen = state?.barOpen === true
  const result = state?.result
  const pending = state?.pending === true
  const [settingsDraft, setSettingsDraft] = useState<readonly ExclusionRule[] | undefined>(undefined)
  const input = useRef<HTMLInputElement | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const wasOpen = useRef(barOpen)
  const inputRef = useCallback((element: HTMLInputElement | null) => { input.current = element }, [])
  // Opening the bar hands the field the keyboard; the header's toggle is a
  // plain button, so the focus has to move from here.
  useEffect(() => {
    if (barOpen && !wasOpen.current) input.current?.focus()
    wasOpen.current = barOpen
  }, [barOpen])
  // One search in flight per pane root: a newer query aborts the older answer,
  // and a preference change re-runs the same query with the new filters.
  // A new array per render would retrigger the effect below forever.
  const excludedPaths = useMemo(() => enabledPaths(preferences.rules), [preferences.rules])
  const attempt = state?.attempt ?? 0
  // The identity of the request this render would send. A settled answer whose
  // identity matches is the SAME request, which is what lets a body remount
  // (opening a file hides the body) reuse it instead of resetting the reader's
  // expansion and offset with an identical replacement answer.
  const requestKey = useMemo(() => searchRequestKey({
    rootId,
    query: trimmed,
    excludedPaths,
    includeHidden: preferences.showHidden,
    respectGitignore: preferences.respectGitignore,
    attempt,
  }), [rootId, trimmed, excludedPaths, preferences.showHidden, preferences.respectGitignore, attempt])
  const settledKey = state?.settledKey ?? ''
  useEffect(() => {
    if (store === undefined || run === undefined || trimmed === '') return
    // Reuse the retained answer for an unchanged request: no request, no
    // `searched` write, so expansion and scrollTop stay where the reader left
    // them. A failed answer counts too — retrying is the button's explicit
    // attempt bump, not an automatic loop every time the effect settles.
    if (settledKey === requestKey) return
    const controller = new AbortController()
    store.searching(stateKey)
    void run(rootId, {
      query: trimmed,
      excludedPaths,
      includeHidden: preferences.showHidden,
      respectGitignore: preferences.respectGitignore,
    }, controller.signal).then((answer) => {
      if (controller.signal.aborted) return
      store.searched(stateKey, {
        kind: 'found',
        query: trimmed,
        tree: buildSearchTree(answer.root, answer.matches),
        count: answer.matches.length,
        truncated: answer.truncated,
        incomplete: answer.incomplete,
        hiddenLeftOut: !preferences.showHidden,
        excluded: excludedPaths.length > 0,
        ignored: preferences.respectGitignore,
      }, requestKey)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      store.searched(stateKey, { kind: 'failed', query: trimmed, failure: failureOf(error) }, requestKey)
    })
    return () => { controller.abort() }
  }, [store, run, stateKey, requestKey, settledKey, rootId, trimmed, excludedPaths,
    preferences.showHidden, preferences.respectGitignore])
  // The result body's offset: restored when the body mounts or a new result
  // lands, mirrored continuously so a remount returns where the reader was.
  useLayoutEffect(() => {
    const body = resultsRef.current
    if (body !== null && result !== undefined) body.scrollTop = state?.scrollTop ?? 0
  }, [result, state?.scrollTop])
  const clear = useCallback(() => {
    store?.setQuery(stateKey, '')
    input.current?.focus()
  }, [store, stateKey])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    moveAlongRows(event)
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (query !== '') {
      event.preventDefault()
      event.stopPropagation()
      clear()
    }
  }
  const closeSettings = (draft: readonly ExclusionRule[], refocus: boolean): void => {
    setSettingsDraft(undefined)
    if (refocus) input.current?.focus()
    if (draft !== preferences.rules) search?.preferences.update(root, { rules: draft })
  }
  if (search === undefined) {
    return (
      <FilesTree
        tabId={tabId} sessionId={filesTree.sessionId} root={root} signal={signal}
        useStore={useStore} actions={actions}
        hold={filesTree.face.hold} release={filesTree.face.release} toggle={filesTree.face.toggle}
        onOpen={onOpenFile} t={filesTree.t} nativeTree={nativeTree}
        menu={filesTree.menu} canOpen={filesTree.canOpen} useCanOpen={filesTree.useCanOpen}
        reveal={reveal} saved={saved} onScrollOffset={onScrollOffset}
      />
    )
  }
  const settings = settingsDraft
  return (
    <div className={CLASS.pane} onKeyDown={onKeyDown}>
      {barOpen && (
        <SearchBar
          query={query}
          showHidden={preferences.showHidden}
          inputRef={inputRef}
          onQuery={value => { store?.setQuery(stateKey, value) }}
          onShowHidden={(value) => { search.preferences.update(root, { showHidden: value }) }}
          // The toggle is a close path too: while the panel is open the click
          // must save the draft exactly like Escape or a blur does, otherwise
          // the exclusion edits vanish (the panel's own mousedown guard keeps
          // blur from committing them first).
          onSettings={() => {
            if (settings === undefined) { setSettingsDraft(preferences.rules); return }
            closeSettings(settings, true)
          }}
          settingsOpen={settings !== undefined}
          t={filesTree.t}
        />
      )}
      {/* Always mounted, so a screen reader announces each new text; empty, it takes no room. */}
      <p className={clsx(CLASS.status, result === undefined && CLASS.statusIdle)} aria-live="polite" data-files-search-status>
        {result?.kind === 'found' && <span className={CLASS.statusLine}>{filesTree.t('search.results', { count: String(result.count) })}</span>}
        {pending && HostStateDot !== undefined && <HostStateDot state="ongoing" size={12} className={CLASS.spinner} />}
      </p>
      {trimmed === '' ? (
        <FilesTree
          tabId={tabId} sessionId={filesTree.sessionId} root={root} signal={signal}
          useStore={useStore} actions={actions}
          hold={filesTree.face.hold} release={filesTree.face.release} toggle={filesTree.face.toggle}
          onOpen={onOpenFile} t={filesTree.t} nativeTree={nativeTree}
          menu={filesTree.menu} canOpen={filesTree.canOpen} useCanOpen={filesTree.useCanOpen}
          showHidden={preferences.showHidden}
          reveal={reveal} saved={saved} onScrollOffset={onScrollOffset}
        />
      ) : (
        <div
          ref={resultsRef}
          className="mrfw-ftBody"
          tabIndex={-1}
          data-mrfw-files-results
          data-files-view="search"
          aria-busy={pending}
          onScroll={(event) => { store?.scrolled(stateKey, event.currentTarget.scrollTop) }}
        >
          {result?.kind === 'failed' ? (
            <SearchFailure failure={result.failure} onRetry={() => { store?.retry(stateKey) }}
              {...(describeFailure === undefined ? {} : { describe: describeFailure })} t={filesTree.t} />
          ) : result?.kind === 'found' ? (
            <>
              <ResultTree
                result={result}
                expanded={state?.expanded ?? result.tree.expanded}
                filesTree={filesTree}
                nativeTree={nativeTree}
                onToggle={(path) => { store?.toggled(stateKey, path) }}
                // A result row's key is the absolute path, exactly like a listed
                // row's: leaving cwd undefined keeps the address absolute, which
                // is what routes the open to the additional root.
                onOpen={path => { onOpenFile(fileAddressFor(filesTree.sessionId, undefined, path)) }}
              />
              <SearchNotes result={result} t={filesTree.t} />
            </>
          ) : null}
        </div>
      )}
      {barOpen && settings !== undefined && (
        <SearchSettings
          rules={settings}
          respectGitignore={preferences.respectGitignore}
          onRules={setSettingsDraft}
          onRespectGitignore={(value) => { search.preferences.update(root, { respectGitignore: value }) }}
          onClose={refocus => { closeSettings(settings, refocus) }}
          t={filesTree.t}
        />
      )}
    </div>
  )
}
