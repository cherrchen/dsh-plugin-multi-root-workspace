/**
 * The tree-key child join, shared by every files-tree module that derives a
 * child row's key from its parent's.
 *
 * It lives apart from `face.ts`/`provider.ts` so neither the provider contract
 * nor the fork carries a dependency cycle through the other. The default
 * spelling is the fork's existing local join: the parent's trailing separators
 * are trimmed and the name is appended after one `/`, whatever the parent's
 * own separator style — the Host resolves mixed separators and the tree only
 * needs a stable key. A provider whose geometry needs a different rule (a
 * remote POSIX-only namespace) supplies its own `joinChild`; every consumer
 * takes it as an optional seam defaulting here.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/resource-path
 */

/** Derive one child row's tree key from its parent's. */
export type JoinTreeChild = (parent: string, name: string) => string

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}
