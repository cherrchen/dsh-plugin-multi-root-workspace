/**
 * Structural adapter for the host's row context menus.
 *
 * `@deepseek-ai/dsh-client-ui-context-menu` exists only from `0.2.2-alpha.3`,
 * and it must never become a build-time dependency: `scripts/upgrade-dsh.mjs`
 * rewrites every `@deepseek-ai` devDependency to each target release, so a
 * pin on this package would kill the 20 lanes older than `alpha.3` at install
 * (ADR-0009 structural probes; the same rule `src/client/workspace-menu.ts`
 * follows for the service facade). What the plugin consumes instead is the
 * root-provided composed prop `useContextMenu` — `ui-context-menu` publishes
 * it to every renderer component through `slots.provideRoot` — plus the
 * service's `registeredKinds` snapshot when the host has it (`rc.2+`).
 *
 * The target values are load-bearing: `path` is the row's ABSOLUTE path. The
 * host's menu contributions resolve it with `workspaceFiles.stat` (routed to
 * the additional root by `src/workspace-files.ts`) and with
 * `resolveWorkspacePath`/`fileAddressFor`, both of which keep an absolute path
 * outside the Session cwd verbatim. A workspace-relative path here would open
 * the primary root's file of the same name.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/context-menu
 */

/** The row kinds the Files tree attaches menus to. */
export type FilesRowKind = 'file' | 'directory'

/** The target object the host's menu registry resolves. */
export interface FilesMenuTarget {
  readonly kind: FilesRowKind
  readonly value: { readonly sessionId: string; readonly path: string }
}

/** Handlers the host's trigger binder returns; spread onto the row's main button. */
export type FilesMenuTriggerProps = Readonly<Record<string, unknown>>

/** The host binding's shape (upstream `ContextMenuBindings`), spelled structurally. */
interface FilesMenuBindings {
  readonly getTriggerProps: (target: FilesMenuTarget) => FilesMenuTriggerProps
}

/** The composed `useContextMenu` prop, spelled structurally. */
export type FilesMenuHook = () => FilesMenuBindings

/** One pane's row-menu attachment, pre-bound to the Session the tree lists for. */
export interface FilesMenuSeat {
  /**
   * The handlers for one row, or `undefined` while the menu must stay shut
   * (the target kind has no registered contributions on this host).
   * @param path - the row's absolute path.
   * @param kind - what the row is.
   * @returns the trigger props to spread, or `undefined` for a plain row.
   */
  readonly trigger: (path: string, kind: FilesRowKind) => FilesMenuTriggerProps | undefined
}

/** A reader for the menu registry's registered target kinds; absent before `0.2.2-rc.2`. */
export type FilesMenuKinds = () => readonly string[] | undefined

/**
 * Read the composed `useContextMenu` prop without importing its package.
 * @param props - the occupant's composed props.
 * @returns the hook when the host provides one.
 */
export function filesMenuHookOf(props: unknown): FilesMenuHook | undefined {
  const hook = (props as { readonly useContextMenu?: unknown } | null | undefined)?.useContextMenu
  return typeof hook === 'function' ? hook as FilesMenuHook : undefined
}

/**
 * Bind one pane's row menus.
 *
 * The menu plugin may be absent (older hosts, a trimmed composition), may be
 * tearing down between renders (the binding call throws), or may expose no
 * trigger binder; every case degrades to "no menu", the same absence the
 * native tree shows on a host without the plugin.
 * @param hook - the host's `useContextMenu` composed prop.
 * @param sessionId - the Session whose resource identity the menu acts on.
 * @param kinds - reads the registered target kinds when the host has that snapshot.
 * @returns the seat, or `undefined` when this host cannot bind menus.
 */
export function filesMenuSeat(
  hook: FilesMenuHook | undefined,
  sessionId: string,
  kinds: FilesMenuKinds | undefined,
): FilesMenuSeat | undefined {
  if (hook === undefined) return undefined
  let bindings: FilesMenuBindings
  try {
    // One call: a disposed menu plugin is the only expected throw, and it means "no menu".
    const raw = hook() as { readonly getTriggerProps?: unknown } | null | undefined
    if (typeof raw?.getTriggerProps !== 'function') return undefined
    bindings = raw as FilesMenuBindings
  } catch {
    return undefined
  }
  return {
    trigger: (path, kind) => {
      // Nullable on purpose: rc.2 added `registeredKinds`; alpha.3 registered its
      // file/directory contributions unconditionally and simply has no snapshot.
      const registered = kinds?.()
      if (registered !== undefined && !registered.includes(kind)) return undefined
      return bindings.getTriggerProps({ kind, value: { sessionId, path } })
    },
  }
}
