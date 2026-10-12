/**
 * Runtime probes for the `@deepseek-ai/dsh-client-ui-primitives` exports the
 * verbatim Files-tree files spell.
 *
 * The upstream imports name the `*Regular` glyph family (0.1.7+; the pixel
 * names are kept as fallbacks for the same reason `compat/client-icons`
 * dual-names them) plus `FileTypeIcon` and `classifyFileType`, which every
 * supported release carries. A named import cannot spell two release eras at
 * once, so the resolution goes through `maybeIcon`/`maybeComponent` — the
 * same probe the open-in-app fork uses.
 *
 * The exported bindings are typed definite because the adapter mounts the
 * tree only after {@link filesTreeSurfaceSupported} passes; reaching for a
 * binding on a composition that failed the gate is a caller bug, and the
 * gate — not this module — is what a missing export degrades into.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/primitives
 */

import { maybeComponent, maybeIcon, type PanelIcon } from '../../compat/client-icons.ts'
import type {} from '@deepseek-ai/dsh-client-ui-primitives'

/** The upstream types the probed exports spell, kept honest by the type-only import. */
type Primitives = typeof import('@deepseek-ai/dsh-client-ui-primitives')

/** Exports the fork's row rendering needs, keyed by their upstream names. */
const probed = {
  folderClose: maybeIcon(['IconFolderCloseRegular', 'IconFolderClose16']),
  folderOpen: maybeIcon(['IconFolderOpenRegular', 'IconFolderOpen16']),
  fileTypeIcon: maybeComponent<Primitives['FileTypeIcon']>(['FileTypeIcon']),
  classifyFileType: maybeComponent<Primitives['classifyFileType']>(['classifyFileType']),
}

/**
 * Whether this composition's primitives carry everything the forked rows
 * spell. The adapter consults this once: `false` means the additional-root
 * menu stays menu-only and no fork mount is attempted — the same absence
 * upstream's own no-such-export state would produce.
 */
export function filesTreeSurfaceSupported(): boolean {
  return probed.folderClose !== undefined
    && probed.folderOpen !== undefined
    && probed.fileTypeIcon !== undefined
    && probed.classifyFileType !== undefined
}

export const IconFolderCloseRegular = probed.folderClose as PanelIcon
export const IconFolderOpenRegular = probed.folderOpen as PanelIcon
export const FileTypeIcon = probed.fileTypeIcon as Primitives['FileTypeIcon']
export const classifyFileType = probed.classifyFileType as Primitives['classifyFileType']
