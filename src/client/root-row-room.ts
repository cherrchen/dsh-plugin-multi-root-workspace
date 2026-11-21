/**
 * One-row room measurement for the workspace dialog's root list.
 *
 * The list is a scroll region that keeps one secondary-root row visible. On a
 * narrow dialog the row layout wraps its actions below the text, so the row is
 * taller than the compact one-row fallback and a fixed floor can show only
 * part of it. The dialog measures the tallest rendered row and publishes it
 * through `--mrfw-root-row-height`; the list can then keep a complete row in
 * view without reserving a fixed wrapped-row height on wide dialogs.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/root-row-room
 */

/** The class every secondary-root row carries. */
const ROOT_ROW_SELECTOR = '.mrfw-row'

/**
 * The tallest rendered secondary-root row.
 * @param list - the root list element.
 * @returns the row height rounded up, or 0 when no row is measurable.
 */
export function measureRootRowHeight(list: HTMLElement): number {
  let tallest = 0
  for (const row of list.querySelectorAll<HTMLElement>(ROOT_ROW_SELECTOR)) {
    const height = row.getBoundingClientRect().height
    if (height > tallest) tallest = height
  }
  return Math.ceil(tallest)
}
