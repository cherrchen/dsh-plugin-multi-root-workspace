// @vitest-environment jsdom
/**
 * The stylesheet rules that position this plugin's launcher inside the
 * upstream Files tab header, and the rules that dress the fork's
 * additional-root tree and workspace search.
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

  it('lets the path label own the free space while the trigger only shrinks', () => {
    expect(STYLES).toMatch(/\.mrfw-rootSwitchBtn\s*\{[^}]*flex:\s*0\s+1\s+auto/s)
    expect(STYLES).toMatch(/\.mrfw-switcherPath\s*\{/s)
  })

  it('unpins the Menu anchor wrapper the header row actually sizes', () => {
    // The button's own min-width: 0 is inert for the row: the row's flex item is
    // Menu's anchor wrapper span. Without min-width: 0 there the wrapper keeps
    // its content's min-content width (the whole nowrap root name) and paints
    // over the reload/search/open-in-app controls that follow it.
    const anchor = STYLES.match(/\.mrfw-rootSwitchAnchor\s*\{([^}]*)\}/s)?.[1]
    expect(anchor).toBeDefined()
    expect(anchor).toMatch(/flex:\s*0\s+1\s+auto/)
    expect(anchor).toMatch(/min-width:\s*0/)
  })

  it('makes the full path yield all of its width before the root name shrinks', () => {
    // A zero flex basis is load-bearing. With upstream's max-content basis both
    // items shrink together, so the root name ellipsizes while the path still
    // shows; with basis 0 the path cannot absorb a deficit and empties first.
    const path = STYLES.match(/\.mrfw-rootSwitcher\s+\.mrfw-switcherPath\s*\{([^}]*)\}/s)?.[1]
    expect(path).toBeDefined()
    expect(path).toMatch(/flex:\s*1\s+1\s+0/)
    expect(path).toMatch(/min-width:\s*0/)
    // The two-class selector must outweigh upstream PathLabel's own .path rule.
    expect(STYLES).toMatch(/\.mrfw-rootSwitcher\s+\.mrfw-switcherPath\s*\{/s)
  })

  it('keeps the trigger box from painting its icons over the next controls', () => {
    // The last-resort yield: below the icons' own width the button clips them.
    expect(STYLES).toMatch(/\.mrfw-rootSwitchBtn\s*\{[^}]*overflow:\s*hidden/s)
  })

  it('fits the root name in three tiers and hides the repeated path tail', () => {
    // The label text is fitted by root-name-fit.ts; this ellipsis is only the
    // fallback for a runtime that cannot measure text.
    expect(STYLES).toMatch(/\.mrfw-rootSwitchLabel\s*\{[^}]*text-overflow:\s*ellipsis/s)
    // The open-in-app fork's seat is a row item at zero width until the
    // catalog loads; the fit observes it for the arrival.
    expect(STYLES).toMatch(/\.mrfw-switcherOpen\s*\{[^}]*display:\s*inline-flex/s)
    // The probe is off-flow and invisible, and the button contains it.
    expect(STYLES).toMatch(/\.mrfw-rootSwitchBtn\s*\{[^}]*position:\s*relative/s)
    expect(STYLES).toMatch(/\.mrfw-rootSwitchProbe\s*\{[^}]*position:\s*absolute[^}]*visibility:\s*hidden/s)
    // A truncated name hides the path's ink — its box stays to keep the header
    // controls at their native offsets.
    expect(STYLES).toMatch(/\.mrfw-rootSwitcher\[data-name-form="middle"\]\s+\.mrfw-switcherPath,\s*\n?\.mrfw-rootSwitcher\[data-name-form="head"\]\s+\.mrfw-switcherPath\s*\{[^}]*visibility:\s*hidden/s)
  })

  it('reproduces the header item gap inside the switcher so replacements keep native offsets', () => {
    // The upstream .header puts 4px between flex items; the takeover renders
    // the reload and the open-in-app fork inside the switcher instead, so the
    // container must carry that same 4px — otherwise the controls drift a few
    // pixels relative to the primary-root layout.
    expect(STYLES).toMatch(/\.mrfw-rootSwitcher\s*\{[^}]*gap:\s*4px/s)
    // The path's right margin (12px) plus that gap reproduces upstream's
    // .path margin-right 12px + header gap 4px; the left gutter now comes
    // from the container gap, so a left margin here would double-count.
    expect(STYLES).toMatch(/\.mrfw-switcherPath\s*\{[^}]*margin:\s*0\s+12px\s+0\s+0/s)
  })

  it('gives the take-over reload the upstream tool-button recipe', () => {
    expect(STYLES).toMatch(/\.mrfw-switcherReload\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s)
    expect(STYLES).toMatch(/\.mrfw-switcherReload:hover\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/s)
  })

  it('hides the native tree body and its reload only while an additional root is selected', () => {
    // The two hooks share one rule: the reload refreshes the very tree that
    // is no longer visible, so it hides under the same condition.
    expect(STYLES).toMatch(
      /\[data-files-root\]:has\(\.mrfw-rootSwitcher\[data-root-kind="additional"\]\)\s*\[data-files-body\],\s*\n?\[data-files-root\]:has\(\.mrfw-rootSwitcher\[data-root-kind="additional"\]\)\s*\[data-files-reload\]\s*\{[^}]*display:\s*none/s,
    )
  })

  it('targets the new Files page without hiding rows or the replacement tree', () => {
    const base = '[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"])'
    expect(STYLES).toContain(`${base} [data-files-content]`)
    expect(STYLES).toContain(`${base} [data-files-reload]`)
    expect(STYLES).toContain(`${base} [data-open-target="directory"]:not(.mrfw-openSplit)`)
    expect(STYLES).toContain('[data-files-page]:has(.mrfw-rootSwitcher) [data-files-path]:not([data-files-entry])')
    document.body.innerHTML = `<div data-files-page><span class="mrfw-rootSwitcher" data-root-kind="additional"></span><div data-files-content></div><div class="mrfw-ftBody"><li data-files-entry="file" data-files-path="/f"></li></div></div>`
    expect(document.querySelector('[data-files-content]')?.matches(`${base} [data-files-content]`)).toBe(true)
    expect(document.querySelector('.mrfw-ftBody')?.matches(`${base} [data-files-content]`)).toBe(false)
    expect(document.querySelector('[data-files-entry]')?.matches('[data-files-page]:has(.mrfw-rootSwitcher) [data-files-path]:not([data-files-entry])')).toBe(false)
  })

  it('gives the portaled tree the stretch-and-scroll recipe of the native body', () => {
    // The fork's own body class — never data-files-body, which the hide rule
    // above would switch off.
    expect(STYLES).toMatch(/\.mrfw-ftBody\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow:\s*auto/s)
  })
})

describe('the additional-root row rules', () => {
  it('rides the access badge beside the name, never shrinking', () => {
    expect(STYLES).toMatch(/\.mrfw-rootName\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s)
    expect(STYLES).toMatch(/\.mrfw-rootNameText\s*\{[^}]*text-overflow:\s*ellipsis/s)
    expect(STYLES).toMatch(/\.mrfw-accessBadge[^{}]*\{[^}]*flex:\s*none/s)
  })

  it('makes the path itself the copy control, icon visible only on hover or focus', () => {
    // The button must stay unstyled (paint like the text around it) and the
    // icon must live in flow at opacity 0 — display:none would re-wrap the
    // string every time it appears.
    expect(STYLES).toMatch(/\.mrfw-pathCopy\s*\{[^}]*background:\s*transparent/s)
    expect(STYLES).toMatch(/\.mrfw-pathCopy\s*\{[^}]*border:\s*0/s)
    expect(STYLES).toMatch(/\.mrfw-pathCopyIcon\s*\{[^}]*opacity:\s*0/s)
    expect(STYLES).toMatch(/\.mrfw-pathCopy:hover\s+\.mrfw-pathCopyIcon[\s\S]*?opacity:\s*1/s)
  })

  it('keeps the danger button on real tokens — an undefined var() whites it out', () => {
    // label-error is an ink, not an alias-layer token this runtime defines:
    // hovering once fell back to transparent and the red button vanished.
    // Both sides of the hover mix must follow the host theme.
    expect(STYLES).toMatch(/\.mrfw-btnDanger\s*\{[^}]*background:\s*var\(--dsw-alias-state-error-primary\)/s)
    expect(STYLES).toMatch(/\.mrfw-btnDanger:hover:not\(:disabled\)\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 85%, var\(--dsw-alias-label-primary\)\)/s)
  })
})

describe('the open-in-app takeover', () => {
  // The hide rule's first selector, spelled once so both the stylesheet
  // assertion and the DOM regression below exercise the exact same string.
  const NATIVE_ITEM_SELECTOR =
    '[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-slot="sidebar.right.tab.files.actions"] > *:has([data-open-target="directory"]:not(.mrfw-openSplit))'

  it('hides the native split button only under an additional root, sparing the fork', () => {
    // The occupant item — the ui-primitives Menu anchor span wrapping the
    // marked control — must go, not just the inner .split: an emptied
    // anchor still sits in the header as a zero-width flex item whose gap
    // pushes the fork left of the native position. The item is reached
    // through the renderer's own data-slot wrapper anchor; that wrapper
    // carries inline display:contents and must never be the target. The
    // descendant selector is the fallback for an upstream that moves the
    // attribute off the item. The fork shares data-open-target
    // byte-for-byte, so both must exclude mrfw-openSplit.
    expect(STYLES).toContain(NATIVE_ITEM_SELECTOR)
    expect(STYLES).toMatch(/\[data-files-root\]:has\(\.mrfw-rootSwitcher\[data-root-kind="additional"\]\)\s+\[data-open-target="directory"\]:not\(\.mrfw-openSplit\)\s*\{[^}]*display:\s*none/s)
    expect(STYLES).not.toMatch(/\[data-open-target="directory"\]\s*\{[^}]*display:\s*none/s)
    // The retired pane-grandchild form hit the data-slot wrapper itself —
    // inert against its inline display:contents, and if that inline style
    // ever vanished it would hide the whole slot, switcher included.
    expect(STYLES).not.toMatch(/>\s*\*\s*>\s*\*:has\(\[data-open-target/)
  })

  it('matches the occupant item, never the slot wrapper or the fork', () => {
    // The header shape upstream's FilesBody plus the scoped-slots renderer
    // produce: actions occupants sit inside a display:contents data-slot
    // wrapper, each occupant a Menu anchor span around its control.
    document.body.innerHTML = `
      <div data-files-root>
        <div class="header">
          <div data-slot="sidebar.right.tab.files.actions" style="display:contents">
            <span class="nativeAnchor"><div data-open-target="directory"></div></span>
            <span class="mrfw-rootSwitcher" data-root-kind="additional">
              <span class="mrfw-openMenuAnchor"><div class="mrfw-openSplit" data-open-target="directory"></div></span>
            </span>
          </div>
        </div>
      </div>`
    const nativeAnchor = document.querySelector('.nativeAnchor')!
    const slotWrapper = document.querySelector('[data-slot]')!
    const switcher = document.querySelector('.mrfw-rootSwitcher')!
    const forkAnchor = document.querySelector('.mrfw-openMenuAnchor')!

    expect(nativeAnchor.matches(NATIVE_ITEM_SELECTOR)).toBe(true)
    expect(slotWrapper.matches(NATIVE_ITEM_SELECTOR)).toBe(false)
    expect(switcher.matches(NATIVE_ITEM_SELECTOR)).toBe(false)
    expect(forkAnchor.matches(NATIVE_ITEM_SELECTOR)).toBe(false)

    // A primary-root selection must leave every element untouched.
    switcher.setAttribute('data-root-kind', 'primary')
    expect(document.querySelectorAll(NATIVE_ITEM_SELECTOR)).toHaveLength(0)
    expect(nativeAnchor.matches(NATIVE_ITEM_SELECTOR)).toBe(false)
  })

  it('carries the forked OpenTargetButton rules under mrfw-open* names', () => {
    expect(STYLES).toMatch(/\.mrfw-openSplit\s*\{[^}]*height:\s*24px[^}]*border:/s)
    expect(STYLES).toMatch(/\.mrfw-openChevron\s*\{[^}]*border-left:/s)
    expect(STYLES).toMatch(/\.mrfw-openMain:hover:not\(:disabled\)/s)
  })
})

describe('the sidebar footer entry rules', () => {
  /** The sheet with comments stripped: every match below is a rule. */
  const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')

  /** One rule's declarations, whitespace-normalized, for recipe equality. */
  const declarations = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rule = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
    return rule?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  }

  it('overhangs the sidebar column like the host row wrapper on both generations', () => {
    // The host's .triggerRow overhangs 2px per side on the 19 legacy-geometry
    // releases and is exactly column-wide on the 5 token-geometry releases.
    // One declaration carries both: an absent --dsh-sidebar-paint-inset falls
    // back to the legacy 0, so the min() terms keep the old +4px / -2px.
    const row = declarations('.mrfw-triggerRow')
    expect(row).toContain('position: relative')
    expect(row).toContain('flex: none')
    expect(row).toContain('width: calc(100% + 4px - min(4px, 2 * var(--dsh-sidebar-paint-inset, 0px)))')
    expect(row).toContain('margin: 4px calc(-2px + min(2px, var(--dsh-sidebar-paint-inset, 0px)))')
  })

  it('reproduces the two host button recipes through tokens with legacy fallbacks', () => {
    const trigger = declarations('.mrfw-trigger')
    // Legacy hosts define none of the --dsh-sidebar-* tokens: the fallbacks
    // resolve to the old 8px padding / 8px gap / 0 border recipe, and the
    // right padding keeps the old asymmetric 10px via max(0px, 2px - 0).
    // Token hosts get 9px content inset, 3px transparent border, 6px gap.
    expect(trigger).toContain('gap: var(--dsh-sidebar-label-gap, 8px)')
    expect(trigger).toContain(
      'padding-inline: calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px)) '
      + 'calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px) + max(0px, 2px - var(--dsh-sidebar-paint-inset, 0px)))',
    )
    expect(trigger).toContain('border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent')
    expect(trigger).toContain('border-radius: var(--dsw-radius-md, 12px)')
    expect(trigger).toContain('background-clip: padding-box')
    // Unchanged from the M3 recipe: height, type scale, transition.
    expect(trigger).toContain('height: 42px')
    expect(trigger).toContain('font-size: 14px')
    expect(trigger).toContain('line-height: 22px')
    expect(trigger).toContain('background: transparent')
    // The hover fill must be a longhand: the `background` shorthand resets
    // background-clip to border-box and paints the fill 3px wider on each side
    // than the host row, which keeps the base rule's padding-box.
    expect(STYLES).toMatch(/\.mrfw-trigger:hover\s*\{[^}]*background-color:\s*var\(--dsw-alias-interactive-bg-hover\)/s)
    const hoverRule = declarations('.mrfw-trigger:hover')
    expect(hoverRule).toContain('background-color: var(--dsw-alias-interactive-bg-hover)')
    expect(hoverRule).not.toMatch(/(?:^|;)\s*background:\s/)
  })

  it('rounds the rail like the 24 releases after the 0.1.6-alpha.2 boundary', () => {
    const rail = declarations('.mrfw-triggerRail')
    // Rail rounding is its own boundary, earlier than the row geometry's: the
    // host has drawn 12px corners since 0.1.6-alpha.2 and only the two oldest
    // supported releases drew a circle (a documented deviation).
    expect(rail).toContain('border-radius: var(--dsw-radius-md, 12px)')
    expect(rail).toContain('border-inline: 0')
    expect(rail).toContain('background-clip: border-box')
    expect(rail).toContain('width: 36px')
    expect(rail).toContain('height: 36px')
    expect(rail).not.toContain('border-radius: 50%')
  })

  it('keeps the rail row a 36px seat inside the column', () => {
    const railRow = declarations('.mrfw-triggerRow.mrfw-railRow')
    expect(railRow).toContain('width: 36px')
    expect(railRow).toContain('margin: 8px 0 10px')
  })

  it('turns the footer slot anchor into a column while this row is mounted', () => {
    // The slot anchor is the host renderer's <div data-slot ... style="display:
    // contents">; an inline style can only be overridden by !important. The
    // :has() scope keeps the rule inert when this plugin is not mounted, and
    // one occupant lays out exactly as display:contents did.
    const anchor = declarations("[data-slot='sidebar.footer.action']:has(.mrfw-triggerRow)")
    expect(anchor).toContain('display: flex !important')
    expect(anchor).toContain('flex-direction: column')
    expect(anchor).toContain('width: 100%')
    expect(anchor).toContain('min-width: 0')
  })

  it('sizes the button like the settings row occupant on hosts with the account launcher', () => {
    // The settings row's visible occupant changed with the host: through
    // 0.1.7-rc.2 it is the 42px settings trigger, and from 0.2.0-rc.1 it is the
    // account menu launcher (AccountMenu.module.css), whose trigger is 44px
    // signed in and 32px signed out. The button follows that height so the two
    // hover surfaces in the footer match; a host without the launcher keeps the
    // 42px settings-trigger height, and the rail keeps its own 36px box.
    expect(declarations("[data-slot='sidebar']:has(button[data-signed-out='true']) .mrfw-trigger:not(.mrfw-triggerRail)")).toContain('height: 32px')
    expect(declarations("[data-slot='sidebar']:has(button[data-signed-out='false']) .mrfw-trigger:not(.mrfw-triggerRail)")).toContain('height: 44px')
    // Fallbacks: the base button (older hosts, no launcher) and the rail.
    expect(declarations('.mrfw-trigger')).toContain('height: 42px')
    expect(declarations('.mrfw-triggerRail')).toContain('height: 36px')
  })

  it('keeps every footer color on host tokens', () => {
    // The footer block runs from the row wrapper to the next rule family.
    const footer = CSS.slice(CSS.indexOf('.mrfw-triggerRow'), CSS.indexOf('.mrfw-heroEntrySeat'))
    expect(footer.trim()).not.toBe('')
    expect(footer).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    const rules = [...footer.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;}]+)/g)]
    for (const rule of rules) {
      const property = rule[1]
      const value = rule[2]?.trim() ?? ''
      if (property === undefined) continue
      if (property === 'color' || property === 'background' || property === 'background-color') {
        expect(value).toMatch(/^(?:var\(--dsw-[^)]*\)|transparent)$/)
      }
      if (property === 'border-radius') expect(value).toMatch(/^var\(--dsw-/)
    }
  })

  it('keeps the hover fill out of a (hover: hover) media query', () => {
    // Deliberate trade-off: 19 of 26 releases have no media wrapper, so this
    // sheet keeps the unwrapped form; the 7 token-geometry releases differ
    // only on devices without hover capability.
    expect(CSS).toContain('.mrfw-trigger:hover')
    expect(CSS.indexOf('.mrfw-trigger:hover')).toBeLessThan(CSS.indexOf('@media'))
  })
})

describe('the New Session hero entry rules', () => {
  it('mirrors the adjacent selectors’ geometry, minus the chevron', () => {
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*min-height:\s*28px/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*padding:\s*0 8px/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*gap:\s*4px/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*border-radius:\s*var\(--dsw-radius-sm\)/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*font-size:\s*13px/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*line-height:\s*20px/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*font-weight:\s*500/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntryIcon\s*\{[^}]*flex:\s*none/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntryLabel\s*\{[^}]*text-overflow:\s*ellipsis/s)
  })

  it('takes its width from the measured room, capped at the 240px selector width', () => {
    // The room is measured, never assumed: 100% would resolve against the
    // content-sized options container and constrain nothing.
    expect(STYLES).toMatch(/\.mrfw-heroEntry\s*\{[^}]*max-width:\s*min\(240px,\s*var\(--mrfw-hero-entry-room,\s*240px\)\)/s)
  })

  it('keeps the row inset on the seat, which is the element the probe pins', () => {
    // The row pads 20px left / 16px right; the extra 4px makes the trigger's
    // box sit at the same 20px inset as the workspace selector, so their
    // icon/text ink lines match at 28px. It rides the seat so the probe can
    // pin the button alone without moving the button's margin box.
    expect(STYLES).toMatch(/\.mrfw-heroEntrySeat\s*\{[^}]*margin:\s*0 4px 0 0/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntrySeat\s*\{[^}]*display:\s*inline-flex/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntrySeat\s*\{[^}]*min-width:\s*0/s)
  })

  it('draws the measured and icon-only forms as one 28x28 box', () => {
    const pinned = STYLES.match(/\.mrfw-heroEntrySeat:is\(\[data-measuring\],\s*\[data-size='compact'\]\) \.mrfw-heroEntry\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(pinned).toMatch(/width:\s*28px/)
    expect(pinned).toMatch(/min-width:\s*28px/)
    expect(pinned).toMatch(/max-width:\s*28px/)
    expect(pinned).toMatch(/padding:\s*0\b/)
    expect(pinned).toMatch(/gap:\s*0\b/)
    expect(STYLES).toMatch(/\.mrfw-heroEntrySeat:is\(\[data-measuring\],\s*\[data-size='compact'\]\) \.mrfw-heroEntryLabel\s*\{\s*display:\s*none/s)
  })

  it('uses the adjacent selectors’ hover/open fill and no literal color', () => {
    expect(STYLES).toMatch(/\.mrfw-heroEntry\[aria-expanded='true'\]\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/s)
    expect(STYLES).toMatch(/\.mrfw-heroEntry:hover\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/s)
    const rules = [...STYLES.matchAll(/\.mrfw-heroEntry[^{]*\{[^}]*\}/g)].map(match => match[0]).join('\n')
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })

  it('keeps the viewport step only as the fallback for an unreadable row', () => {
    // A probe that cannot identify the row leaves data-size off; only then may
    // the viewport approximation apply. A measured room always wins, because
    // the column narrows without the viewport doing so (sidebar, preview pane).
    const media = STYLES.match(/@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/)
    expect(media).toBeTruthy()
    expect(media![1]).toMatch(/\.mrfw-heroEntrySeat:not\(\[data-size\]\) \.mrfw-heroEntry\s*\{[^}]*width:\s*28px/s)
    expect(media![1]).toMatch(/\.mrfw-heroEntrySeat:not\(\[data-size\]\) \.mrfw-heroEntry\s*\{[^}]*padding:\s*0/s)
    expect(media![1]).toMatch(/\.mrfw-heroEntrySeat:not\(\[data-size\]\) \.mrfw-heroEntryLabel\s*\{\s*display:\s*none/s)
    // A measured entry must never be dragged back by the viewport rule.
    expect(media![1]).not.toMatch(/\n\s*\.mrfw-heroEntry\s*\{/)
  })

  it('does not claim the shared list slot', () => {
    // `conversation.hero.options` is a list slot: entries render as direct
    // flex children of `.heroOptions` through a display:contents outlet. The
    // trigger must stay in flow and must not grow, so another plugin's entry
    // can sit beside it instead of being pushed out.
    const rule = STYLES.match(/\.mrfw-heroEntry\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(rule).not.toMatch(/flex:\s*1|flex-grow:\s*[1-9]|position:\s*absolute|width:\s*100%/)
  })

  it('never reintroduces a chevron rule', () => {
    expect(STYLES).not.toContain('.mrfw-heroEntryChevron')
  })
})

describe('the navigator search takeover (0.2.2-rc.2)', () => {
  /** The bar selector's guard must stay in the source, not just in this test. */
  const BAR = 'aside[data-mrfw-navigator] > div:not([data-mrfw-files-pane]):has([data-files-search])'
  const STATUS = 'aside[data-mrfw-navigator] > [data-files-search-status]'
  const SETTINGS = 'aside[data-mrfw-navigator] > [data-files-search-settings]'

  it('hides the native search bar, status line, and leftover settings — and nothing of the plugin pane', () => {
    // The rc.2 navigator draws a workspace search above the body; the retarget
    // hides the body it belongs to, so the bar must go with it. The :has()
    // anchor is the input rc.2 marks as data-files-search, and the status line
    // and settings popover are direct children. Primary-root browsing carries
    // no marker. The :not() guard is defensive: the plugin's own pane is a
    // direct child too, and a future upstream selector change must not hide it.
    expect(STYLES).toMatch(/aside\[data-mrfw-navigator\]\s*>\s*div:not\(\[data-mrfw-files-pane\]\):has\(\[data-files-search\]\)/)
    expect(STYLES).toContain('aside[data-mrfw-navigator] > [data-files-search-status]')
    expect(STYLES).toContain('aside[data-mrfw-navigator] > [data-files-search-settings]')
    document.body.innerHTML = `
      <aside data-mrfw-navigator>
        <div class="searchBar"><div class="searchField"><input data-files-search></div></div>
        <p data-files-search-status></p>
        <section data-files-search-settings></section>
        <div class="mrfw-fsPane" data-mrfw-files-pane>
          <div class="mrfw-fsBar"><input data-mrfw-files-search></div>
          <p data-files-search-status></p>
          <section data-files-search-settings></section>
          <div class="mrfw-ftBody"></div>
        </div>
        <div data-files-body></div>
      </aside>
      <aside><div class="searchBar"><input data-files-search></div><p data-files-search-status></p></aside>`
    const [held, native] = [...document.querySelectorAll('aside')]
    const pane = held!.querySelector<HTMLElement>('.mrfw-fsPane')!
    const directChildren = [...held!.children]
    // The native instances, direct children of the held aside, are matched.
    expect(held!.querySelector('.searchBar')!.matches(BAR)).toBe(true)
    expect(directChildren.find(element => element.matches('[data-files-search-status]'))!.matches(STATUS)).toBe(true)
    expect(directChildren.find(element => element.matches('[data-files-search-settings]'))!.matches(SETTINGS)).toBe(true)
    // The plugin pane is not the native bar, and its own same-named hooks are
    // nested behind the pane: the direct-child rules never reach them.
    expect(pane.matches(BAR)).toBe(false)
    expect(pane.querySelector('[data-files-search-status]')!.matches(STATUS)).toBe(false)
    expect(pane.querySelector('[data-files-search-settings]')!.matches(SETTINGS)).toBe(false)
    expect(pane.querySelector('.mrfw-ftBody')!.matches(BAR)).toBe(false)
    // No marker means no hiding at all — the native preview keeps its bar.
    expect(native!.querySelector('.searchBar')!.matches(BAR)).toBe(false)
    expect(native!.querySelector('[data-files-search-status]')!.matches(STATUS)).toBe(false)
  })

  it('lays the SSH form out in a field grid instead of a column of row-sized inputs', () => {
    // .mrfw-input was a horizontal-row control: its flex-basis is a width
    // there, but a height in a column. The form must never inherit it, and the
    // fields themselves must sit in a real grid.
    expect(STYLES).toMatch(/\.mrfw-sshForm \.mrfw-input\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(STYLES).toMatch(/\.mrfw-sshGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
    expect(STYLES).toMatch(/\.mrfw-sshGridThree\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s)
    expect(STYLES).toMatch(/\.mrfw-sshAddDialog\s*\{[^}]*width:\s*min\(760px,\s*100%\)/s)
    expect(STYLES).toMatch(/\.mrfw-sshCredentialRow\s*\{[^}]*display:\s*flex/s)
    expect(STYLES).toMatch(/\.mrfw-sshCredentialRow\s*\{[^}]*align-items:\s*flex-end/s)
    expect(STYLES).toMatch(/\.mrfw-sshInput,\s*\.mrfw-sshHelperInput,\s*\.mrfw-teamInput,\s*\.mrfw-sshSelectControl,\s*button\.mrfw-sshButton\s*\{[^}]*height:\s*32px;/)
    expect(STYLES).toMatch(/\.mrfw-sshInput\s*\{[^}]*width:\s*100%/s)
    expect(STYLES).toMatch(/\.mrfw-sshField\s*\{[^}]*flex-direction:\s*column/s)
  })

  it('hides the Files-page search toggle under an additional root only', () => {
    const base = '[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"])'
    expect(STYLES).toContain(`${base} [data-files-search-toggle]`)
    expect(STYLES).toContain('[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-search-toggle]')
    document.body.innerHTML = `<div data-files-page><span class="mrfw-rootSwitcher" data-root-kind="additional"></span><button data-files-search-toggle></button></div>`
    const selector = `${base} [data-files-search-toggle]`
    expect(document.querySelector('[data-files-search-toggle]')!.matches(selector)).toBe(true)
    document.querySelector('.mrfw-rootSwitcher')!.setAttribute('data-root-kind', 'primary')
    expect(document.querySelector('[data-files-search-toggle]')!.matches(selector)).toBe(false)
  })
})

describe('the custody-mode and alert rules', () => {
  it('keeps the mode option title on a defined label token', () => {
    expect(STYLES).toMatch(/\.mrfw-modeOptionTitle\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/s)
    expect(STYLES).not.toMatch(/\.mrfw-modeOptionTitle\s*\{[^}]*--dsw-alias-label\)/s)
  })

  it('keeps the SSH dialog alert on the error-primary token', () => {
    expect(STYLES).toMatch(/\.mrfw-alert\s*\{[^}]*color:\s*var\(--dsw-alias-state-error-primary\)/s)
  })
})

describe('the additional-root search styles (0.2.2-rc.2)', () => {
  /** The stylesheet with its comments stripped: every match below is a rule. */
  const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')

  // One entry per upstream rule the fork renames, so a dropped rule fails here
  // even when no other assertion names it.
  const SEARCH_CLASSES = [
    'mrfw-fsPane',
    'mrfw-fsBar',
    'mrfw-fsField',
    'mrfw-fsTool',
    'mrfw-fsInput',
    'mrfw-fsStatus',
    'mrfw-fsStatusIdle',
    'mrfw-fsStatusLine',
    'mrfw-fsSpinner',
    'mrfw-fsFailure',
    'mrfw-fsRetry',
    'mrfw-fsEmptyNote',
    'mrfw-fsInfoBtn',
    'mrfw-fsSettings',
    'mrfw-fsSettingsHeader',
    'mrfw-fsSettingsTitle',
    'mrfw-fsSettingsDesc',
    'mrfw-fsSettingsError',
    'mrfw-fsSettingsOption',
    'mrfw-fsRules',
    'mrfw-fsRule',
    'mrfw-fsRuleOff',
    'mrfw-fsRuleLabel',
    'mrfw-fsRuleCheck',
    'mrfw-fsRuleName',
    'mrfw-fsRuleInput',
    'mrfw-fsAddRule',
    'mrfw-fsToolBtn',
    'mrfw-fsIcon',
  ] as const

  /** Every rule block whose selector names one class. */
  const blocks = (className: string): string[] =>
    [...CSS.matchAll(new RegExp(`\\.${className}(?![\\w-])[^{}]*\\{[^}]*\\}`, 'g'))].map(match => match[0])

  /** One rule's declarations, whitespace-normalized, for recipe equality. */
  const declarationsOf = (rule: string | undefined): string => {
    if (rule === undefined) return ''
    return rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
      .split(';')
      .map(part => part.replace(/\s+/g, ' ').trim())
      .filter(part => part !== '')
      .join(';')
  }

  it('maps every upstream search rule into the mrfw-fs* namespace', () => {
    for (const className of SEARCH_CLASSES) expect(CSS).toContain(`.${className}`)
    // The tree's rc.2 additions and the header toggle live outside mrfw-fs*.
    for (const className of ['mrfw-ftMatch', 'mrfw-ftHidden', 'mrfw-ftInactive', 'mrfw-switcherSearch']) {
      expect(CSS).toContain(`.${className}`)
    }
  })

  it('draws the pane as the navigator column that owns the bar height', () => {
    const pane = blocks('mrfw-fsPane')[0]
    expect(pane).toBeDefined()
    expect(pane).toMatch(/display:\s*flex/)
    expect(pane).toMatch(/flex-direction:\s*column/)
    expect(pane).toMatch(/flex:\s*1 1 auto/)
    expect(pane).toMatch(/min-height:\s*0/)
    expect(pane).toMatch(/--files-search-bar-height:\s*42px/)
    // The settings panel is absolute; without a positioned pane it would
    // anchor to the page and float over the header instead of the tree.
    expect(pane).toMatch(/position:\s*relative/)
  })

  it('reproduces the coarse-pointer targets, bar, rules, and field size', () => {
    expect(CSS).toContain('@media (pointer: coarse)')
    const coarse = CSS.slice(CSS.indexOf('@media (pointer: coarse)'))
    expect(coarse).toMatch(/\.mrfw-fsTool\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s)
    expect(coarse).toMatch(/\.mrfw-fsPane\s*\{[^}]*--files-search-bar-height:\s*50px/s)
    expect(coarse).toMatch(/\.mrfw-fsRule\s*\{[^}]*min-height:\s*44px/s)
    expect(coarse).toMatch(/\.mrfw-fsInput,\s*\.mrfw-fsRuleInput\s*\{[^}]*font-size:\s*16px/s)
  })

  it('keeps the bar, field, tool, and settings geometry on the upstream recipe', () => {
    expect(blocks('mrfw-fsBar')[0]).toMatch(/height:\s*var\(--files-search-bar-height\)/)
    expect(blocks('mrfw-fsField')[0]).toMatch(/background:\s*var\(--dsw-alias-bg-layer-1\)/)
    expect(CSS).toMatch(/\.mrfw-fsField:focus-within\s*\{[^}]*border-color:\s*var\(--dsw-alias-state-business-primary\)/s)
    expect(CSS).toMatch(/\.mrfw-fsTool svg\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/s)
    expect(CSS).toMatch(/\.mrfw-fsInput::-webkit-search-cancel-button\s*\{\s*display:\s*none/s)
    const settings = blocks('mrfw-fsSettings')[0]
    expect(settings).toMatch(/position:\s*absolute/)
    expect(settings).toMatch(/top:\s*var\(--files-search-bar-height\)/)
    expect(settings).toMatch(/box-shadow:\s*var\(--dsw-elevation-prominent\)/)
    expect(blocks('mrfw-fsSettingsOption')[0]).toMatch(/border-top:\s*none/)
  })

  it('gives the settings header controls the header tool recipe', () => {
    const tool = blocks('mrfw-fsToolBtn')[0]
    expect(tool).toMatch(/width:\s*28px/)
    expect(tool).toMatch(/height:\s*28px/)
    expect(tool).toMatch(/padding:\s*6px/)
    expect(tool).toMatch(/color:\s*var\(--dsw-alias-label-secondary\)/)
    expect(CSS).toMatch(/\.mrfw-fsToolBtn:hover\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/s)
    expect(CSS).toMatch(/\.mrfw-fsToolBtn\[aria-pressed='true'\]/)
  })

  it('flattens the nested helpers onto the names the pane applies', () => {
    expect(CSS).toMatch(/\.mrfw-fsAddRule \.mrfw-fsIcon\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary\)/s)
    expect(CSS).toMatch(/\.mrfw-fsAddRule:focus-within\s*\{[^}]*border-top-color:\s*var\(--dsw-alias-state-business-primary\)/s)
    expect(CSS).toMatch(/\.mrfw-fsRuleOff \.mrfw-fsRuleName\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary\)/s)
  })

  it('maps the tree hidden, inactive, and match rules onto the mrfw-ft* names', () => {
    expect(blocks('mrfw-ftHidden')[0]).toMatch(/color:\s*var\(--dsw-alias-label-secondary\)/)
    // The refused row keeps cancelling the row hover fill, under the new
    // upstream name and the fork's legacy spelling alike.
    expect(CSS).toMatch(/@media \(hover: hover\)\s*\{\s*\.mrfw-ftInactive:hover,\s*\.mrfw-ftOther:hover\s*\{[^}]*background:\s*transparent/s)
    // The current-file fill stays the fork's, not upstream's .match rule.
    expect(CSS).toMatch(/\.mrfw-ftRow\[data-files-current\]/)
  })

  it('marks search matches with the business primary ink', () => {
    const match = blocks('mrfw-ftMatch')[0]
    expect(match).toMatch(/color:\s*var\(--dsw-alias-state-business-primary\)/)
    expect(match).toMatch(/background:\s*transparent/)
  })

  it('gives the header search toggle the reload recipe verbatim', () => {
    const [reload, reloadHover] = blocks('mrfw-switcherReload')
    const [search, searchHover] = blocks('mrfw-switcherSearch')
    expect(search).toBeDefined()
    expect(searchHover).toBeDefined()
    expect(declarationsOf(search)).toBe(declarationsOf(reload))
    expect(declarationsOf(searchHover)).toBe(declarationsOf(reloadHover))
    // The button sits where the native search toggle sat, right after the
    // reload replacement.
    expect(CSS.indexOf('.mrfw-switcherSearch')).toBeGreaterThan(CSS.indexOf('.mrfw-switcherReload'))
  })

  it('keeps every new color, background, and font declaration on host tokens', () => {
    const newRules = [
      CSS.slice(CSS.indexOf('.mrfw-fsPane'), CSS.indexOf('.mrfw-openMenuAnchor')),
      ...['mrfw-ftMatch', 'mrfw-ftHidden', 'mrfw-ftInactive', 'mrfw-switcherSearch'].flatMap(name => blocks(name)),
    ].join('\n')
    expect(newRules.trim()).not.toBe('')
    // No literal color format and no CSS named color may reach the sheet.
    expect(newRules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(newRules).not.toMatch(/\b(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink|brown|cyan|magenta|silver|maroon|navy|olive|teal|aqua|lime|fuchsia)\b/i)
    const declarations = [...newRules.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;}]+)/g)]
    for (const declaration of declarations) {
      const property = declaration[1]
      const value = declaration[2]?.trim() ?? ''
      if (property === undefined) continue
      const colorProperty = property === 'color' || property === 'background' || property === 'background-color'
        || property === 'accent-color' || property === 'outline-color'
        || (property.startsWith('border') && property.endsWith('-color'))
      if (colorProperty) expect(value).toMatch(/^(?:var\(--dsw-[^)]*\)|transparent)$/)
      if (property === 'font' || property === 'font-family') expect(value).toMatch(/^(?:var\(--dsw-[^)]*\)|inherit)$/)
      if (property === 'outline') expect(value).toMatch(/^(?:var\(--dsw-|none$)/)
      if (property === 'box-shadow') expect(value).toMatch(/^var\(--dsw-/)
      if (property.startsWith('border') && !property.endsWith('-color') && value.includes('solid')) expect(value).toContain('var(--dsw-')
    }
  })
})

describe('the worktree suggestion notice rules', () => {
  /** The sheet with comments stripped; the notice block runs to the next rule family. */
  const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')
  const notice = CSS.slice(CSS.indexOf('.mrfw-notice {'), CSS.indexOf('.mrfw-select {'))

  it('leaves the old bottom-right corner entirely', () => {
    expect(CSS).not.toContain('.mrfw-toast')
    expect(notice).not.toMatch(/right:\s*24px/)
    expect(notice).not.toMatch(/bottom:\s*24px/)
    expect(notice).toMatch(/position:\s*fixed/)
  })

  it('draws one borderless, theme-adaptive elevated card', () => {
    expect(notice).toMatch(/border:\s*0;/)
    expect(notice).toMatch(/border-radius:\s*var\(--dsw-radius-lg(?:,\s*var\(--dsw-radius-md\))?\)/)
    expect(notice).toMatch(/background:\s*var\(--dsw-alias-bg-layer-2\)/)
    expect(notice).toMatch(/box-shadow:\s*var\(--dsw-elevation-panel\)/)
    // The surface follows the active theme; it is not the always-dark Toast token.
    expect(notice).not.toContain('--dsw-alias-toast-bg')
    expect(notice).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })

  it('centers both seats and keeps a compact 32px two-row form', () => {
    expect(CSS).toMatch(/\.mrfw-notice\s*\{[^}]*transform:\s*translateX\(-50%\)/s)
    expect(CSS).toMatch(/\.mrfw-notice\[data-compact='true'\]\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(CSS).toMatch(/\.mrfw-notice\[data-compact='true'\] \.mrfw-noticeAction\s*\{[^}]*height:\s*32px[^}]*padding:\s*0 12px/s)
  })

  it('draws remind-me-later as a framed split text and chevron control', () => {
    expect(CSS).toMatch(/\.mrfw-noticeSplit\s*\{[^}]*display:\s*inline-flex[^}]*box-shadow:\s*inset 0 0 0 0\.5px var\(--dsw-alias-border-l3\)/s)
    expect(CSS).toMatch(/\.mrfw-noticeSplitToggle\s*\{[^}]*width:\s*24px[^}]*border-left:\s*0\.5px solid var\(--dsw-alias-border-l3\)/s)
    expect(CSS).toMatch(/\.mrfw-notice\[data-compact='true'\] \.mrfw-noticeSplit\s*\{[^}]*height:\s*32px/s)
    expect(CSS).toMatch(/\.mrfw-notice\[data-compact='true'\] \.mrfw-noticeSplitToggle\s*\{[^}]*width:\s*32px/s)
  })

  it('parks one small circular close badge on the top-right corner', () => {
    // Drawn by this sheet rather than by a primitive: the compact control rules
    // fix a taller height and a smaller corner radius, which would turn the
    // badge into a rounded rectangle.
    expect(notice).toMatch(/\.mrfw-notice \.mrfw-noticeClose\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*right:\s*0[^}]*width:\s*18px[^}]*height:\s*18px[^}]*padding:\s*0[^}]*border-radius:\s*50%/s)
    // The seat is pulled 2px inside the geometric corner on both axes: a corner
    // badge reads as balanced only slightly off the mathematical center.
    expect(notice).toMatch(/transform:\s*translate\(calc\(50%\s*-\s*2px\),\s*calc\(-50%\s*\+\s*2px\)\)/s)
    // One hairline stroke delimits the circle against the card corner.
    expect(notice).toMatch(/\.mrfw-notice \.mrfw-noticeClose\s*\{[^}]*border:\s*0\.5px solid var\(--dsw-alias-border-l3\)[^}]*border-radius:\s*50%/s)
    // The badge wears the card surface and the host's ink tokens, never a literal color.
    expect(notice).toMatch(/\.mrfw-notice \.mrfw-noticeClose\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2\)[^}]*color:\s*var\(--dsw-alias-label-secondary\)/s)
    // Hovering leaves the surface exactly as it is: no tint and no transparency.
    expect(notice).not.toMatch(/mrfw-noticeClose:hover/)
    expect(notice).not.toMatch(/mrfw-noticeClose:active/)
    // The 18px circle still offers a 24px pointer target.
    expect(notice).toMatch(/\.mrfw-notice \.mrfw-noticeClose::after\s*\{[^}]*inset:\s*-3px/s)
    expect(notice).toMatch(/\.mrfw-notice \.mrfw-noticeClose:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--dsw-alias-brand-primary\)/s)
  })

  it('fades in and honors reduced motion', () => {
    expect(CSS).toMatch(/@keyframes mrfw-notice-fade/)
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.mrfw-notice\s*\{\s*animation:\s*none/s)
  })
})

describe('the workspace folder add row', () => {
  it('keeps the controls on one line by letting the manual path field shrink first', () => {
    expect(STYLES).toMatch(/\.mrfw-actions\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(STYLES).toMatch(/\.mrfw-manualPath\s*\{[^}]*flex:\s*1 1 120px[^}]*min-width:\s*80px/s)
  })

  it('gives the root-limit hint its own line above the controls, under the divider', () => {
    // Both lines live inside the bordered footer block: the hint claims a full
    // flex line and the controls wrap onto the line after it.
    expect(STYLES).toMatch(/\.mrfw-actions\s*\{[^}]*border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\)/s)
    expect(STYLES).toMatch(/\.mrfw-actionsNote\s*\{[^}]*flex:\s*0 0 100%/s)
  })
})

describe('the additional-section batch action', () => {
  it('right-aligns the action on the title row and wraps instead of overflowing', () => {
    // The modifier is what lets a narrow dialog put the action on its own line;
    // the base title row (the primary section) keeps its baseline layout.
    expect(STYLES).toMatch(/\.mrfw-sectionTitleRowAction\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(STYLES).toMatch(/\.mrfw-sectionAction\s*\{[^}]*margin-left:\s*auto[^}]*align-self:\s*center[^}]*display:\s*inline-flex/s)
    const baseTitleRow = STYLES.slice(STYLES.indexOf('.mrfw-sectionTitleRow {'), STYLES.indexOf('.mrfw-sectionTitle {'))
    expect(baseTitleRow).toMatch(/display:\s*flex/)
    expect(baseTitleRow).toMatch(/align-items:\s*baseline/)
    expect(baseTitleRow).not.toMatch(/flex-wrap/)
  })
})

describe('the worktree dialog rules', () => {
  /** The sheet with comments stripped; the worktree block runs to the next family. */
  const CSS = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')
  const worktree = CSS.slice(CSS.indexOf('.mrfw-worktreeDialog {'), CSS.indexOf('.mrfw-stateWarn {'))

  it('widens the card and keeps one continuous list', () => {
    expect(worktree).toMatch(/\.mrfw-worktreeDialog\s*\{[^}]*width:\s*min\(860px,\s*100%\)/s)
    expect(worktree).toMatch(/\.mrfw-worktreeRow\s*\{[^}]*border-bottom:\s*0\.5px solid/s)
    expect(worktree).not.toMatch(/\.mrfw-worktreeRow\s*\{[^}]*border-radius/s)
    expect(worktree).not.toMatch(/\.mrfw-worktreeRow\s*\{[^}]*border:\s*0\.5px solid/s)
  })

  it('styles the branch chip, the access selector and the footer', () => {
    expect(worktree).toMatch(/\.mrfw-worktreeBranch\s*\{[^}]*font-family:\s*var\(--ds-font-family-code\)/s)
    expect(worktree).toMatch(/\.mrfw-worktreeAccess\s*\{[^}]*max-width:\s*180px/s)
    expect(STYLES).toMatch(/\.mrfw-worktreeFooter\s*\{[^}]*justify-content:\s*space-between/s)
  })
})
