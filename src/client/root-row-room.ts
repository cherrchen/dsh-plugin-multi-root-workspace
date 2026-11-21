/**
 * One-row room measurement for the workspace dialog's root list.
 *
 * On a narrow dialog a row can wrap its actions below the text. The dialog
 * publishes the tallest rendered row through `--mrfw-root-row-height` so the
 * list can fit a complete row whenever it fits within the viewport cap.
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
