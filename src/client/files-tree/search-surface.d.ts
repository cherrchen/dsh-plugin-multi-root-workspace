/**
 * Ambient surface for the fork's search pane on older hosts.
 *
 * The pane (`pane.tsx`) spells the export names of upstream `0.2.2-rc.3`;
 * several of those names postdate the oldest supported releases, and named
 * imports must resolve on EVERY matrix version because tsc and the bundler
 * check the whole graph:
 *
 * - older pins lack the `*Regular` glyph family, `StateDot`, `Button`, and
 *   Tooltip's newer `maxWidth`/`openOnClick` props;
 * - `0.1.7-alpha.1` and later carry the `*Regular` glyph family;
 * - `0.2.2-rc.2` and later pass the search pane's host gate
 *   (`workspaceFiles.search`).
 *
 * Declaring the missing members here merges them into the installed package's
 * module: on old pins they are the only declarations, so the named imports
 * resolve; on newer ones an identical-shape declaration merges harmlessly and
 * the extra Tooltip and StateDot signatures are just more overloads. Runtime is
 * unaffected either way — the pane mounts only behind the search availability
 * probe, so a binding an old runtime does not provide stays unused. This file
 * is types-only; it exists to satisfy the compiler on release lines the search
 * cannot run on anyway, not to pretend they can.
 *
 * Sync: keep every declaration equal to the shape `pane.tsx` spells. The
 * same pattern, with the same caveats, is
 * `src/client/open-in-app/upstream-surface.d.ts`.
 */

import type { IconProps, TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Glyph names the pane spells verbatim, declared with upstream's own shape. */
  export const IconSearchOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconEyeOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconEyeOffOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconCloseOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconInfoOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconPlusOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconTrashOutlineRegular: (props: IconProps) => import('react').JSX.Element
  export const IconRefreshOutlineRegular: (props: IconProps) => import('react').JSX.Element

  /**
   * The in-flight search indicator. `state` is required on every supported
   * release; the declaration pins the one state the pane draws, so the merge
   * stays an overload rather than widening the real union.
   */
  export function StateDot(props: {
    state: 'ongoing'
    size?: number
    className?: string
  }): import('react').JSX.Element

  /**
   * The result notes' and settings panel's button. The props are the union of
   * the variants the pane spells; `data-*` attributes build the pane's DOM
   * hooks and pass through the index signature.
   */
  export const Button: (props: {
    variant?: 'ghost' | 'outline' | 'solid'
    size?: 'sm'
    className?: string
    'aria-label'?: string
    onClick?: () => void
    children?: import('react').ReactNode
  } & { [key: `data-${string}`]: string | undefined }) => import('react').JSX.Element

  /**
   * `shortcutKeys` reached Tooltip in 0.1.7-rc.2 and `portal` in
   * 0.1.7-alpha.1; `maxWidth` and `openOnClick` postdate the oldest releases,
   * and the search pane spells all of them. The props below are the union of
   * every supported release's Tooltip surface (copied from the open-in-app
   * fork), so the overload stays usable — and stays a subset in spirit —
   * wherever it merges.
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
