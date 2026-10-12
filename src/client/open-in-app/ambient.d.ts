/**
 * Ambient types for the forked open-in-app components.
 *
 * `ShortcutCatalogEntry` is a type-only import in the forked files — the
 * runtime value is the shortcuts service's `catalog` snapshot, which the
 * adapter soft-probes (`ctx.get('shortcuts')`) instead of injecting. The
 * declaration carries exactly the members the fork reads (`id` for the
 * `workspace.openLocal` lookup, `keys`/`aria` for the tooltip), not the
 * upstream interface's whole surface. See FORK.md.
 */
declare module '@deepseek-ai/dsh-client-shortcuts/client' {
  export interface ShortcutCatalogEntry {
    readonly id: string
    readonly keys: readonly string[]
    readonly aria: string | undefined
  }
}
