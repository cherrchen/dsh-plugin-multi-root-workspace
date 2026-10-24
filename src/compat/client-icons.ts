/**
 * Compatibility adapter for the product icons the panel renders.
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   IconFolderClose16, IconChevronDownOutline14, …  (pixel size in the name)
 * 0.1.7-alpha.1 through 0.2.0-rc.2   IconFolderCloseRegular, IconChevronDownOutlineRegular, …  (weight in the name)
 * ```
 *
 * `0.1.7-alpha.1` kept `size` as a prop and split each glyph into a Regular
 * (1px) and a Medium (1.3px) weight. Upstream's own client surfaces use
 * Regular for these glyphs, so that is the name this probe prefers after the
 * pixel-sized one. The lookup is by export name, not by release string.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/client-icons
 */

import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** One icon component, spelled the way both releases spell `IconProps`. */
export type PanelIcon = (props: IconProps) => ReactNode

/** Exports addressed by name. A release carries one name from each pair. */
type IconModule = Readonly<Record<string, PanelIcon | undefined>>

/**
 * The installed icon module, addressed by export name.
 *
 * Named imports cannot spell both releases: each name is absent from the
 * other release's declaration, so the compiler is told once, here.
 */
const installed = primitives as unknown as IconModule

/**
 * Pick the first export name this release actually provides.
 * @param module - the icon module to read.
 * @param names - candidate export names, preferred first.
 * @returns the component.
 * @throws {Error} when none of the names is exported. That is a compatibility
 *   break to adapt here, not a missing optional peer.
 */
export function selectIcon(module: IconModule, names: readonly string[]): PanelIcon {
  for (const name of names) {
    const found = module[name]
    if (found !== undefined) return found
  }
  throw new Error(
    'multi-root workspace: @deepseek-ai/dsh-client-ui-primitives exports none of '
    + `${names.join(', ')}; the workspace-folders panel cannot render its icons. `
    + 'Adapt src/compat/client-icons.ts to the installed release.',
  )
}

/**
 * The same by-name probe for a decorative glyph a release may simply not
 * carry: absence degrades to no icon, not to a boot error. Required icons go
 * through `selectIcon` and fail loud; optional ones go through here.
 */
export function maybeIcon(names: readonly string[]): PanelIcon | undefined {
  for (const name of names) {
    const found = installed[name]
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The same by-name probe for a whole component a release may not carry:
 * `PathLabel` arrived in `0.1.7-alpha.1`, so pixel-era runtimes degrade to a
 * plain span where the header invites one. Absence degrades to no component,
 * not to a boot error.
 */
export function maybeComponent<T>(names: readonly string[]): T | undefined {
  return maybeIcon(names) as T | undefined
}

/** Resolved once, against the installed module. */
function icon(pixelName: string, regularName: string): PanelIcon {
  return selectIcon(installed, [pixelName, regularName])
}

export const IconChevronDown = icon('IconChevronDownOutline14', 'IconChevronDownOutlineRegular')
export const IconChevronUp = icon('IconChevronUpOutline14', 'IconChevronUpOutlineRegular')
export const IconCopy = icon('IconCopyOutline16', 'IconCopyOutlineRegular')
export const IconEdit = icon('IconEditOutline16', 'IconEditOutlineRegular')
export const IconEllipsis = icon('IconEllipsisOutline16', 'IconEllipsisOutlineRegular')
export const IconFolderClose = icon('IconFolderClose16', 'IconFolderCloseRegular')
export const IconFolderOpen = icon('IconFolderOpenOutline16', 'IconFolderOpenOutlineRegular')
export const IconPlus = icon('IconPlusOutline16', 'IconPlusOutlineRegular')
export const IconRefresh = icon('IconRefreshOutline16', 'IconRefreshOutlineRegular')
export const IconSettings = icon('IconSettingsOutline16', 'IconSettingsOutlineRegular')
export const IconTrash = icon('IconTrashOutline16', 'IconTrashOutlineRegular')

// The permission glyphs exist only from 0.1.7-alpha.1 on; earlier releases
// render the access picker's menu rows — and its trigger — without icons.
export const IconAccessReadWrite = maybeIcon(['PermissionIconWorkspaceWriteRegular', 'IconWorkspaceWriteRegular'])
export const IconAccessReadOnly = maybeIcon(['PermissionIconReadOnlyRegular', 'IconReadOnlyRegular'])
export const IconAccessInherit = maybeIcon(['IconWorkspaceTreeOutline16', 'IconWorkspaceTreeOutlineRegular'])
