/** Adapt the legacy listing store to the host's optional controlled tree Factory. */
export interface NativeTreeEntry {
  readonly path: string
  readonly name: string
  readonly meta: { readonly kind: 'file' | 'directory' | 'other' }
}

type Level<F> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: F }
  | { readonly kind: 'ready'; readonly level: { readonly entries: readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other' }[]; readonly truncated: boolean }; readonly failure?: F }

/** Render function supplied to a slot occupant by newer renderer builds. */
export type NativeTreeRenderer = (name: string, input: object, options: { fallback: unknown }) => unknown

export function nativeTreeRenderer(value: unknown): NativeTreeRenderer | undefined {
  return typeof value === 'function' ? value as NativeTreeRenderer : undefined
}

/** The revealed file's identity, forwarded as the factory's `current`/`currentRef` inputs. */
export interface NativeTreeCurrent {
  /** The current row's tree key — the factory marks it `.current` + `aria-current`. */
  readonly path: string
  /** Optional callback ref for the current row's button — the reveal's scroll target. */
  readonly ref?: ((row: unknown) => void) | undefined
}

/** Handlers bound to a row's main control; opaque to this adapter (the host's menu binding). */
export type NativeTreeTriggerProps = Record<string, unknown>

/**
 * Context-menu attachment for one row: the handlers the host's menu binding
 * returns for that row's target, or `undefined` when the menu must stay shut.
 *
 * The Factory spreads whatever this returns onto the row's main button, so the
 * shape is the host's `ContextMenuTriggerProps`, deliberately not imported
 * here: the package is absent before `0.2.2-alpha.3` and must never become a
 * build-time dependency (AGENTS.md, ADR-0009 structural probes).
 */
export type NativeTreeRowTriggers = (entry: NativeTreeEntry, kind: 'file' | 'directory') => NativeTreeTriggerProps | undefined

/**
 * Optional Factory inputs this adapter can supply on newer hosts. Every member
 * is optional and older Factories ignore unknown input keys, so one call site
 * serves every supported release: `rowTriggerProps`/`canOpen` arrived with the
 * Factory itself (`0.2.2-alpha.3`), and search-related inputs
 * (`highlight`/`omitted`) with `0.2.2-rc.2`.
 */
export interface NativeTreeOptions {
  /** The revealed file's identity. */
  readonly current?: NativeTreeCurrent | undefined
  /** Row context menus; absent when this host has no menu service. */
  readonly rowTriggerProps?: NativeTreeRowTriggers | undefined
  /** Whether a file row opens at all (the host's registered viewers); absent leaves every file openable. */
  readonly canOpen?: ((entry: NativeTreeEntry) => boolean) | undefined
  /** Search text whose occurrences inside each name are highlighted (`0.2.2-rc.2+`). */
  readonly highlight?: string | undefined
  /**
   * Leaves entries out of the drawn levels: `'hidden'` says the directory holds
   * only hidden entries, `'unmatched'` says these entries are a selection such
   * as search matches instead of a complete listing (`0.2.2-rc.2+`).
   */
  readonly omitted?: 'hidden' | 'unmatched' | undefined
  /**
   * Directories whose listed entries were all filtered out as hidden. Their
   * state carries `omitted: 'hidden'` so the Factory draws the "only hidden
   * entries" line instead of claiming the directory is empty. Only meaningful
   * when the caller pre-filtered the levels.
   */
  readonly hiddenOnly?: ReadonlySet<string> | undefined
}

/** The factory consumes absolute, slash-separated keys and already-localized errors. */
export function nativeTreeInput<F>(
  state: { readonly root: string; readonly levels: Readonly<Record<string, Level<F>>>; readonly expanded: readonly string[] },
  failureLine: (failure: F) => string,
  toggle: (parent: string, path: string) => void,
  open: (path: string) => void,
  options: NativeTreeOptions = {},
): object {
  const root = state.root.replace(/[/\\]+$/, '')
  const keyOf = (path: string): string => path === state.root ? root : path
  const entries: NativeTreeEntry[] = []
  const directories: Record<string, { loading?: true; failure?: string; truncated?: true; omitted?: 'hidden' | 'unmatched' }> = {}
  for (const path of state.expanded) directories[keyOf(path)] = { loading: true }
  for (const [path, level] of Object.entries(state.levels)) {
    const key = keyOf(path)
    if (level.kind === 'loading') directories[key] = { loading: true }
    else if (level.kind === 'failed') directories[key] = { failure: failureLine(level.failure) }
    else {
      const status: { failure?: string; truncated?: true; omitted?: 'hidden' | 'unmatched' } = {}
      if (level.failure !== undefined) status.failure = failureLine(level.failure)
      if (level.level.truncated) status.truncated = true
      if (options.omitted !== undefined) status.omitted = options.omitted
      else if (options.hiddenOnly?.has(path) === true) status.omitted = 'hidden'
      directories[key] = status
      for (const entry of level.level.entries) entries.push({
        path: `${path.replace(/[/\\]+$/, '')}/${entry.name}`, name: entry.name, meta: { kind: entry.type },
      })
    }
  }
  const current = options.current
  const rowTriggerProps = options.rowTriggerProps
  const canOpen = options.canOpen
  return {
    root, entries, directories, expanded: state.expanded.map(keyOf),
    // The native FileTree's `current`/`currentRef` inputs: the row whose key
    // matches is marked `.current` + `aria-current` and gets the ref, which is
    // how the host's own navigator highlights and grabs the revealed row.
    ...(current === undefined ? {} : { current: current.path, currentRef: current.ref }),
    // Per-row context menus and viewer availability (`0.2.2-alpha.3+`); absent
    // members leave the Factory's own defaults (native browser menu, every file
    // openable).
    ...(rowTriggerProps === undefined ? {} : { rowTriggerProps }),
    ...(canOpen === undefined ? {} : { canOpen }),
    ...(options.highlight === undefined ? {} : { highlight: options.highlight }),
    onToggle: (entry: NativeTreeEntry) => {
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
      toggle(parent === root ? state.root : parent, entry.path)
    },
    onOpen: (entry: NativeTreeEntry) => { open(entry.path) },
  }
}
