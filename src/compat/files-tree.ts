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

/** The factory consumes absolute, slash-separated keys and already-localized errors. */
export function nativeTreeInput<F>(
  state: { readonly root: string; readonly levels: Readonly<Record<string, Level<F>>>; readonly expanded: readonly string[] },
  failureLine: (failure: F) => string,
  toggle: (parent: string, path: string) => void,
  open: (path: string) => void,
  current?: NativeTreeCurrent | undefined,
): object {
  const root = state.root.replace(/[/\\]+$/, '')
  const keyOf = (path: string): string => path === state.root ? root : path
  const entries: NativeTreeEntry[] = []
  const directories: Record<string, { loading?: true; failure?: string; truncated?: true }> = {}
  for (const path of state.expanded) directories[keyOf(path)] = { loading: true }
  for (const [path, level] of Object.entries(state.levels)) {
    const key = keyOf(path)
    if (level.kind === 'loading') directories[key] = { loading: true }
    else if (level.kind === 'failed') directories[key] = { failure: failureLine(level.failure) }
    else {
      const status: { failure?: string; truncated?: true } = {}
      if (level.failure !== undefined) status.failure = failureLine(level.failure)
      if (level.level.truncated) status.truncated = true
      directories[key] = status
      for (const entry of level.level.entries) entries.push({
        path: `${path.replace(/[/\\]+$/, '')}/${entry.name}`, name: entry.name, meta: { kind: entry.type },
      })
    }
  }
  return {
    root, entries, directories, expanded: state.expanded.map(keyOf),
    // The native FileTree's `current`/`currentRef` inputs: the row whose key
    // matches is marked `.current` + `aria-current` and gets the ref, which is
    // how the host's own navigator highlights and grabs the revealed row.
    ...(current === undefined ? {} : { current: current.path, currentRef: current.ref }),
    onToggle: (entry: NativeTreeEntry) => {
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
      toggle(parent === root ? state.root : parent, entry.path)
    },
    onOpen: (entry: NativeTreeEntry) => { open(entry.path) },
  }
}
