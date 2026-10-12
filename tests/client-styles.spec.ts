/**
 * The stylesheet rules that position this plugin's launcher inside the
 * upstream Files tab header.
 *
 * The launcher's place in that header is a CSS `order` effect, not a slot
 * registration property: upstream sorts `files.actions` occupants inside
 * their own slot, so the only way to sit between the path label and the
 * reload button is the flex order of the wrapper element. These assertions
 * pin the rules that effect depends on — an accidental edit that drops the
 * `order` declarations silently reverts the header to the slot order.
 */

import { describe, expect, it } from 'vitest'
import { STYLES } from '../src/client/styles.ts'

describe('the Files-tab launcher rules', () => {
  it('moves the launcher ahead of every order-0 sibling in the header flex row', () => {
    expect(STYLES).toMatch(/\.mrfw-fileLauncher\s*\{[^}]*order:\s*-1/s)
  })

  it('pins the upstream path label ahead of the launcher, guarded by :has()', () => {
    // Naming an upstream element is only safe behind the launcher anchor:
    // without :has() the rule would restyle a header the plugin is not in.
    // The :not([data-files-entry]) qualifier is mandatory too — upstream
    // puts data-files-path on every tree row, not just the header label.
    expect(STYLES).toMatch(/\[data-files-root\]:has\(\.mrfw-fileLauncher\)\s*\[data-files-path\]:not\(\[data-files-entry\]\)\s*\{[^}]*order:\s*-2/s)
  })
})

describe('the root-switcher rules', () => {
  it('takes over the path label position and hides only the header label', () => {
    expect(STYLES).toMatch(/\.mrfw-rootSwitcher\s*\{[^}]*order:\s*-1/s)
    // Every tree row also carries data-files-path; dropping the :not() would
    // blank the native tree instead of just the PathLabel — the exact bug
    // this assertion exists to keep from regressing.
    expect(STYLES).toMatch(/\[data-files-root\]:has\(\.mrfw-rootSwitcher\)\s*\[data-files-path\]:not\(\[data-files-entry\]\)\s*\{[^}]*display:\s*none/s)
  })

  it('hides the native tree body and its reload only while an additional root is selected', () => {
    // The two hooks share one rule: the reload refreshes the very tree that
    // is no longer visible, so it hides under the same condition.
    expect(STYLES).toMatch(
      /\[data-files-root\]:has\(\.mrfw-rootSwitcher\[data-root-kind="additional"\]\)\s*\[data-files-body\],\s*\n?\[data-files-root\]:has\(\.mrfw-rootSwitcher\[data-root-kind="additional"\]\)\s*\[data-files-reload\]\s*\{[^}]*display:\s*none/s,
    )
  })

  it('gives the portaled tree the stretch-and-scroll recipe of the native body', () => {
    expect(STYLES).toMatch(/\.mrfw-switcherTree\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow:\s*auto/s)
  })
})
