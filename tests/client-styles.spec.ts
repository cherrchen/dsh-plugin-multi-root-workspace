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
    // The PathLabel brings its own grow/clip styles; the plugin's rules only
    // keep the trigger from competing for the same space.
    expect(STYLES).toMatch(/\.mrfw-rootSwitchBtn\s*\{[^}]*flex:\s*0\s+1\s+auto/s)
    expect(STYLES).toMatch(/\.mrfw-switcherPath\s*\{/s)
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
  it('hides the native search bar and status line only while the preview retarget holds the aside', () => {
    // The rc.2 navigator draws a workspace search above the body; the retarget
    // hides the body it belongs to, so the bar must go with it. The :has()
    // anchor is the input rc.2 marks as data-files-search, and the status line
    // is a direct sibling. Primary-root browsing carries no marker.
    expect(STYLES).toMatch(/aside\[data-mrfw-navigator\]\s*>\s*div:has\(\[data-files-search\]\)[\s\S]*?display:\s*none/s)
    expect(STYLES).toContain('aside[data-mrfw-navigator] > [data-files-search-status]')
    document.body.innerHTML = `
      <aside data-mrfw-navigator>
        <div class="searchBar"><div class="searchField"><input data-files-search></div></div>
        <p data-files-search-status></p>
        <div data-files-body></div>
        <div class="mrfw-ftBody"></div>
      </aside>
      <aside><div class="searchBar"><input data-files-search></div><p data-files-search-status></p></aside>`
    const [held, native] = [...document.querySelectorAll('aside')]
    expect(held!.querySelector('.searchBar')!.matches('aside[data-mrfw-navigator] > div:has([data-files-search])')).toBe(true)
    expect(held!.querySelector('[data-files-search-status]')!.matches('aside[data-mrfw-navigator] > [data-files-search-status]')).toBe(true)
    expect(native!.querySelector('.searchBar')!.matches('aside[data-mrfw-navigator] > div:has([data-files-search])')).toBe(false)
    // The forked body must never match the search-bar selector.
    expect(held!.querySelector('.mrfw-ftBody')!.matches('aside[data-mrfw-navigator] > div:has([data-files-search])')).toBe(false)
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
