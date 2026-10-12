/**
 * Ambient surface for the fork's pinned upstream revision.
 *
 * The verbatim files spell the export names of upstream `0.2.1-alpha.2`; two
 * of those names postdate the oldest supported releases, and named imports
 * must resolve on EVERY matrix version because tsc and the bundler check the
 * whole graph:
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   icon glyphs spell pixel names (Icon*14/Icon*16);
 *                      Tooltip has no `shortcutKeys` or `portal` props
 * 0.1.7-alpha.1 +      the `*Regular` glyph family exists; `portal` and
 *                      `shortcutKeys` join Tooltip (rc.2 for the latter)
 * ```
 *
 * Declaring the missing members here merges them into the installed package's
 * module: on pixel-era releases they are the only declarations, so the named
 * imports resolve; on newer ones an identical-shape const merges harmlessly
 * and the extra Tooltip signature is just another overload.
 *
 * Runtime is unaffected either way — the fork's components mount only behind
 * the adapter's `*Regular` glyph gate, so a binding an old runtime does not
 * provide stays `undefined` and is never rendered. This file is types-only;
 * it exists to satisfy the compiler on release lines the fork cannot run on
 * anyway, not to pretend they can.
 */

import type { IconProps, TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Glyph names the fork spells verbatim, declared with upstream's own shape. */
  export const IconChevronDownOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconFolderOpenOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconRightUpOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconWarningOutlineRegular: (props: IconProps) => import('react').JSX.Element

  /**
   * `shortcutKeys` reached Tooltip in 0.1.7-rc.2 and `portal` in
   * 0.1.7-alpha.1; an extra overload admits the fork's call where the real
   * signature predates them. The props below are the union of every
   * supported release's Tooltip surface, so the overload stays usable — and
   * stays a subset in spirit — wherever it merges.
   */
  export function Tooltip(props: {
    label: string | (() => string)
    shortcutKeys?: readonly string[] | undefined
    side?: TooltipSide
    align?: 'center' | 'end'
    delayMs?: number
    focusDelayMs?: number
    gap?: number
    disabled?: boolean
    portal?: boolean
    maxWidth?: number
    openOnClick?: boolean
    children: import('react').ReactElement
  }): import('react').JSX.Element
}
