/**
 * The plugin's one stylesheet, injected into the document by the client entry.
 *
 * The host ships its design tokens as CSS custom properties on `body`
 * (`--dsw-alias-*` semantics, `--dsw-elevation-*` shadows, `--ds-*` motion and
 * code-font tokens), so this sheet names no color of its own: light and dark
 * theme follow the host automatically. The recipes mirror the native surfaces
 * this UI sits beside — the sidebar footer trigger, the Modal primitive, and
 * the capsule Button (ADR-0006 records the decision). The footer trigger is
 * the host's two trigger generations folded into one token-plus-fallback
 * recipe, plus the coexistence rule for a second footer action; ADR-0044
 * records that decision.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/styles
 */

/** The stylesheet text; every class is prefixed `mrfw-` to stay collision-free. */
export const STYLES = /* css */ `
/* Sidebar footer row: the host's two trigger recipes in one declaration set.
 * Across the 19 releases up to 0.2.1-rc.5 the host row overhangs each side by
 * 2px against the column's 12px inline padding (width calc(100% + 4px),
 * margin 4px -2px) and its button pads 0 10px 0 8px with an 8px gap. From
 * 0.2.2-alpha.2 the host row is exactly column-wide and the button pads by
 * --dsh-sidebar-row-padding minus --dsh-sidebar-paint-inset (12 - 3 = 9px)
 * inside a 3px transparent inset border, with a 6px label gap. Legacy hosts
 * define none of the --dsh-sidebar-* custom properties, so every fallback is
 * the legacy value and this one recipe is pixel-exact on both generations
 * (ADR-0044 D2). The right padding's max(0px, 2px - inset) restores the legacy
 * recipe's asymmetric 10px only where the token is absent; on token hosts it
 * resolves to 0. */
.mrfw-triggerRow {
  /* The host added position: relative in 0.1.6-alpha.2. The two oldest
     releases lack it, which is inert here: the row has no positioned
     descendant. */
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px - min(4px, 2 * var(--dsh-sidebar-paint-inset, 0px)));
  margin: 4px calc(-2px + min(2px, var(--dsh-sidebar-paint-inset, 0px)));
}

.mrfw-triggerRow.mrfw-railRow {
  width: 36px;
  margin: 8px 0 10px;
}

.mrfw-trigger {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--dsh-sidebar-label-gap, 8px);
  width: auto;
  height: 42px;
  margin: 0;
  padding-block: 0;
  padding-inline:
    calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px))
    calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px)
      + max(0px, 2px - var(--dsh-sidebar-paint-inset, 0px)));
  border: none;
  border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  background-clip: padding-box;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

/* The fill stays outside @media (hover: hover) on purpose: the host added that
   wrapper only in 0.2.2-alpha.2, so the unwrapped form matches the 19 legacy
   releases and differs on the 5 token releases only on devices without hover
   capability (ADR-0044 D2).

   background-color, not the background shorthand: the shorthand resets
   background-clip to border-box and would paint the fill over the 3px
   transparent inset border, 6px wider than the host row (whose hover
   longhand keeps the base rule's padding-box) — ADR-0044 §修订三. */
.mrfw-trigger:hover {
  background-color: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-triggerIcon {
  flex: none;
  display: inline-flex;
}

.mrfw-triggerLabel {
  overflow: hidden;
  white-space: nowrap;
}

/* Rail rounding has its own, earlier boundary than the row geometry: since
   0.1.6-alpha.2 the host's rail trigger carries the 12px --dsw-radius-md
   corner (0.2.2-alpha.2 only added the token padding and the transparent
   border), and only the two oldest supported releases draw a circle. This
   formula matches 22 of the 24 releases; the two circles are a documented
   deviation (ADR-0044 D2). */
.mrfw-triggerRail {
  flex: none;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  gap: 0;
  justify-content: center;
  border-inline: 0;
  background-clip: border-box;
  border-radius: var(--dsw-radius-md, 12px);
}

/* The settings row's visible occupant changed with the host: through
   0.1.7-rc.2 it is the 42px settings trigger, and from 0.2.0-rc.1 it is the
   account menu launcher, whose trigger is 44px signed in and 32px signed out
   (AccountMenu.module.css). The button follows that height so the two hover
   surfaces in the footer are the same size; a host without the launcher keeps
   the 42px settings-trigger height above, and the rail keeps its own 36px box.
   Only the height follows: the left inset, gap, radius and hover token are
   shared with the host recipe, so the icon and label lines stay where the
   host's rows put them. The marker is the launcher's own data attribute, so a
   host that renames it falls back to 42px (today's size) rather than
   mis-sizing. */
[data-slot='sidebar']:has(button[data-signed-out='true']) .mrfw-trigger:not(.mrfw-triggerRail) {
  height: 32px;
}

[data-slot='sidebar']:has(button[data-signed-out='false']) .mrfw-trigger:not(.mrfw-triggerRail) {
  height: 44px;
}

/* The footer slot is a list slot with a shipped occupant that usually renders
   nothing (the official ui-cordis badge), so a second row can really appear.
   The host .footerActions is a single-line flex and every occupant is a
   full-width item, which pushes the later one out of the column. While this
   plugin's row is mounted, the renderer's slot anchor itself becomes a
   vertical column so each occupant owns one full row. The anchor carries an
   inline display: contents — only !important overrides it. Scoping the rule
   with :has(.mrfw-triggerRow) keeps it inert when this plugin is not mounted
   (host layout unchanged), .mrfw-triggerRow exists only in this slot, and one
   occupant lays out exactly as display: contents did (ADR-0044 D3). */
[data-slot='sidebar.footer.action']:has(.mrfw-triggerRow) {
  display: flex !important;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}

/* New Session hero row: the Workspace Folders entry rides
   conversation.hero.options at the row's right edge. Geometry mirrors the
   adjacent workspace and agent-preset selectors (28px height, 0 8px padding,
   4px gap, 13px/20px/500, the same hover/open fill) so the three read as one
   control family. It opens a dialog, not a menu, so it carries no chevron.

   The seat carries the row inset that keeps this trigger's box 20px from the
   card edge, mirroring the workspace selector's 20px left inset, and it is
   the element the room probe pins. */
.mrfw-heroEntrySeat {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  margin: 0 4px 0 0;
}

/* The row's options container is flex: none, so this entry cannot shrink the
   way its neighbors do; hero-entry-room.ts measures the room the row leaves
   after them and the sheet clamps the button to it. The label ellipsizes down
   to HERO_ENTRY_LABEL_MIN_PX, then the icon-only form takes over. */
.mrfw-heroEntry {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: min(240px, var(--mrfw-hero-entry-room, 240px));
  min-height: 28px;
  margin: 0;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-heroEntry[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

@media (hover: hover) {
  .mrfw-heroEntry:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.mrfw-heroEntryIcon {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-primary);
}

.mrfw-heroEntryLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Icon-only form, and the probe's pin: data-measuring holds the seat at that
   width for the one synchronous read of the row, so the controls before it
   show their natural widths rather than the ones the label already squeezed.
   Both states are the same 28x28 box, so the probe never changes the layout
   it restores. */
.mrfw-heroEntrySeat:is([data-measuring], [data-size='compact']) .mrfw-heroEntry {
  width: 28px;
  min-width: 28px;
  max-width: 28px;
  padding: 0;
  justify-content: center;
  gap: 0;
}

.mrfw-heroEntrySeat:is([data-measuring], [data-size='compact']) .mrfw-heroEntryLabel {
  display: none;
}

/* Fallback while the probe cannot identify the hero row (an upstream DOM
   change, or a tree without layout): the entry keeps its content-sized max
   width, and 560px — the host's own compact step in InputBar.module.css —
   still degrades it to the icon alone. The measured form scopes this rule
   out, so a real room always wins over the viewport approximation. */
@media (max-width: 560px) {
  .mrfw-heroEntrySeat:not([data-size]) .mrfw-heroEntry {
    width: 28px;
    min-width: 28px;
    padding: 0;
    justify-content: center;
    gap: 0;
  }

  .mrfw-heroEntrySeat:not([data-size]) .mrfw-heroEntryLabel {
    display: none;
  }
}

/* Icon-only launcher inside the upstream Files tab header. Upstream's
   FilesBody renders .header as one flat flex row — PathLabel, then the
   reload button, then the files.actions slot occupants — and each of those
   children carries a stable data-files-* attribute on the flex item itself
   (data-files-root on the pane, data-files-path, data-files-reload).
   A registration order sorts only INSIDE the actions slot and can never
   overtake the reload button, so the launcher is moved with the flex order
   property instead: this wrapper is the slot's root element and therefore a
   direct flex item of .header, and order: -1 puts it ahead of every
   order-0 sibling while the :has() rule below keeps the path first. */
.mrfw-fileLauncher {
  order: -1;
  flex: none;
  display: flex;
  align-items: center;
}

/* Pin the upstream path label ahead of the launcher — but only while this
   plugin is in the row: the :has() guard keeps a rule that names an
   upstream element inert whenever the launcher is absent. The
   :not([data-files-entry]) qualifier is load-bearing, not decorative:
   upstream puts data-files-path on EVERY tree row too (the row's own
   absolute path), so an unqualified selector would match the whole tree,
   not just the header's PathLabel. Both selectors depend on upstream's DOM
   shape, which is not part of the slot contract; if it changes, the rules
   simply stop matching and the launcher falls back to its in-slot position —
   a silent degradation, never a broken header. */
[data-files-root]:has(.mrfw-fileLauncher) [data-files-path]:not([data-files-entry]) {
  order: -2;
}

/* The root switcher is the launcher's grown-up form on runtimes whose
   files.actions owner carries absolutePath. It takes the path label's flex
   position and stretch: order: -1 ahead of every order-0 sibling, and a
   growing min-width:0 item so both the trigger label and the PathLabel
   inside it can ellipsize instead of pushing the header controls out. */
.mrfw-rootSwitcher {
  order: -1;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  /* Same 4px the upstream .header puts between its own flex items, so the
     takeover controls (reload, open-in-app fork) sit at the same offsets the
     hidden native ones did — no drift between primary and additional state. */
  gap: 4px;
}

/* The Menu primitive's anchor wrapper is the direct flex item of the row above,
   and it is a plain inline-flex span with the default min-width: auto. In a
   narrow header that pins the trigger at its content's min-content width (the
   trigger label is nowrap, so the whole root name), so the wrapper outgrows the
   width the switcher was assigned and paints over the reload/search/open-in-app
   items after it. The shrink has to live HERE rather than on the inner button:
   min-width: 0 lets the wrapper take only the width the header has for it, and
   the button and label (both min-width: 0 already) then ellipsize. Menu forwards
   className to this wrapper on every supported release, so no version gate. */
.mrfw-rootSwitchAnchor {
  flex: 0 1 auto;
  min-width: 0;
}

/* While the switcher exists it hides the upstream path label — the
   :has() guard again keeps the upstream-naming rule inert unless this
   plugin is actually in the row. The switcher draws its own PathLabel of
   the selected root next to the trigger (className mrfw-switcherPath, no
   data-files-* attributes), so the header keeps a path in the same spot.
   :not([data-files-entry]) is what confines this rule to the header:
   every tree row carries data-files-path with its own path as the value,
   and only the PathLabel carries it bare. Without the qualifier this
   display:none would blank the entire native tree. */
[data-files-root]:has(.mrfw-rootSwitcher) [data-files-path]:not([data-files-entry]) {
  display: none;
}

/* While the switcher names an additional root, the native tree body and its
   reload hide: the reload refreshes the very tree that is no longer
   visible, and the plugin's forked tree is portaled in as the body's sibling.
   The header still offers a reload — the switcher's own .mrfw-switcherReload
   calls the forked face's refresh. The native tree keeps watching in the
   background, so switching back to the primary root restores it instantly. */
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-body],
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-reload] {
  display: none;
}

/* Newer Files pages place the navigator beside the header instead of
   wrapping both in data-files-root. Target the page without hiding the
   portaled replacement or any of its rows. */
[data-files-page]:has(.mrfw-fileLauncher) [data-files-path]:not([data-files-entry]) { order: -2; }
[data-files-page]:has(.mrfw-rootSwitcher) [data-files-path]:not([data-files-entry]) { display: none; }
[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-content],
[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-reload] { display: none; }
[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-slot="sidebar.right.tab.files.actions"] > *:has([data-open-target="directory"]:not(.mrfw-openSplit)),
[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-open-target="directory"]:not(.mrfw-openSplit) { display: none; }

/* While the switcher names an additional root, the native open-in-app split
   button hides too: its slot props carry the pane's primary root, so it
   would always open the primary root no matter what the switcher selected.
   The header gets the plugin's own fork of that same control instead (the
   open-in-app directory), wired to the selected root.

   The slot's render site is wrapped in the renderer's own anchor —
   <div data-slot="sidebar.right.tab.files.actions" style="display:contents">
   — so the header's flex items inside it are the occupants themselves, and
   the native item is the ui-primitives Menu anchor span wrapping the marked
   .split. The first selector hides that occupant item through the data-slot
   anchor: hiding only the inner control would leave the empty anchor span
   as a zero-width flex item whose header gap pushes the fork 4px left of
   the native position. The wrapper itself can never be the target — its
   inline display:contents beats any stylesheet rule, and hiding it would
   take the switcher with it. The second selector is the fallback for an
   upstream that moves the attribute off the item. The fork survives both:
   the only data-open-target inside .mrfw-rootSwitcher is its own
   .mrfw-openSplit, which :not() excludes. */
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-slot="sidebar.right.tab.files.actions"] > *:has([data-open-target="directory"]:not(.mrfw-openSplit)),
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-open-target="directory"]:not(.mrfw-openSplit) {
  display: none;
}

/* The trigger borrows the path label's look: quiet text with a folder
   glyph, the hover of the neighboring header buttons, and the overflow
   behavior PathLabel itself uses in a narrow header. It may shrink but
   never grows — the PathLabel after it owns the free header space. Its own
   overflow is hidden so a pane narrower than the trigger's icons (plus the
   fixed header controls) clips them at the trigger box instead of painting
   them over the reload/search controls; upstream's header overflows at that
   width too, but overlapping controls are worse than a clipped glyph. */
.mrfw-rootSwitchBtn {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  margin: 0;
  padding: 0 4px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: inherit;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-rootSwitchBtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-rootSwitchBtn .mrfw-triggerIcon {
  color: var(--dsw-alias-label-secondary);
}

/* The label text is fitted to the measured width in three tiers (whole name,
   head and tail, head alone — see root-name-fit.ts); the ellipsis here is only
   the fallback for a runtime that cannot measure text. */
.mrfw-rootSwitchLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The off-flow probe a runtime without an offscreen canvas measures candidate
   strings in. It inherits the label's font from the button and never takes
   part in the row. */
.mrfw-rootSwitchProbe {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
  font: inherit;
  line-height: inherit;
}

/* The open-in-app fork's seat: a flex item that sizes to the split button and
   stays in the row (at zero width) while the catalog is still loading. */
.mrfw-switcherOpen {
  display: inline-flex;
  min-width: 0;
}

/* While the name is truncated the path's own tail would repeat the same root
   in a second, differently cut form — and only a sliver of it fits next to the
   shortened name. The ink is hidden but the box stays: it keeps absorbing the
   leftover width so the reload/search/open-in-app controls stay at their
   native offsets. */
.mrfw-rootSwitcher[data-name-form="middle"] .mrfw-switcherPath,
.mrfw-rootSwitcher[data-name-form="head"] .mrfw-switcherPath {
  visibility: hidden;
}

.mrfw-rootSwitchChevron {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
}

/* The selected root's full path sits between the trigger and the reload —
   the very PathLabel upstream draws there, so it brings its own left-clip and
   hover-title behavior; only the gutters and the yield order are ours. The
   right margin plus the container gap reproduces upstream's .path
   margin-right 12px + header gap 4px; the left gutter comes from the same
   container gap.

   A zero flex basis is what makes the path yield before the root name: with
   flex-grow it still fills every spare pixel, but it owns no base width to
   give back, so a deficit reaches the trigger only after the path has already
   collapsed to zero. Upstream's own max-content basis would shrink both items
   at once and ellipsize the root name while the path still had room.
   min-width: 0 covers the plain-span fallback used on runtimes without
   PathLabel, whose text would otherwise keep its min-content width. */
.mrfw-rootSwitcher .mrfw-switcherPath {
  flex: 1 1 0;
  min-width: 0;
  margin: 0 12px 0 0;
}

/* The PathLabel fallback (a runtime without the primitive) has no clip rule
   of its own; keep its one line inside the box the same way .path does. */
.mrfw-switcherPath:not([data-path-label]) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* The takeover's own reload, standing exactly where the hidden native one
   did: the upstream .tool recipe verbatim (28px hit area, 15px glyph,
   secondary voice, hover fills). It calls the forked face's refresh — an
   in-place re-list, not a remount. */
.mrfw-switcherReload {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  line-height: 1;
  cursor: pointer;
}

.mrfw-switcherReload:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The takeover's own search toggle, standing exactly where the native one sat
   (after the reload): the same upstream .tool recipe verbatim as the reload
   above — 28px hit area, 15px glyph from the icon prop, secondary voice, and
   the same hover fill. It renders only where the host exposes workspace
   search, and it opens the forked bar, not the native one. */
.mrfw-switcherSearch {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  line-height: 1;
  cursor: pointer;
}

.mrfw-switcherSearch:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The document preview's navigator aside, while the retarget holds it: the
   native body hides (it lists the session's primary root regardless of the
   previewed file), and the forked tree — portaled in as the aside's sibling
   child — takes the same stretch item in the aside's column flex, right
   down to the body's own padding and 2px scrollbar offset. The aside's
   chrome is untouched: width, push/overlay/fill modes, and the resize
   separator all stay native. The marker attribute is set only while a
   takeover actually holds the aside, so a navigator we never matched — or
   one whose plugin sheet is gone — renders exactly as upstream drew it. */
aside[data-mrfw-navigator] > [data-files-body] {
  display: none;
}

/* Upstream 0.2.2-rc.2 added the navigator's workspace search bar above the
   tree, plus a Files-page header toggle that opens it. The bar searches the
   SESSION's working directory and draws its results into the native body;
   while a takeover shows another root's tree that body is hidden, so the bar
   would offer a search rooted at the primary root whose result can never
   appear. Hide the bar and its status line with the native body they belong
   to, and the header toggle under the same additional-root condition as the
   native reload. Primary-root browsing keeps the untouched upstream bar.

   The :not() guard is defensive: the plugin's own search pane is a direct
   child of the same aside and carries data-files-search* hooks of its own, so
   a future upstream selector change must never hide the replacement. The
   settings popover is hidden only as a DIRECT child: that is the native
   instance a takeover can leave behind for one paint when its draft was open,
   while the plugin's own panel nested inside the pane stays untouched. */
aside[data-mrfw-navigator] > div:not([data-mrfw-files-pane]):has([data-files-search]),
aside[data-mrfw-navigator] > [data-files-search-status],
aside[data-mrfw-navigator] > [data-files-search-settings] {
  display: none;
}

[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-search-toggle],
[data-files-page]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-search-toggle] {
  display: none;
}

/* The reveal's current row, the fork's spelling of upstream's .current:
   the interactive-active fill, kept under hover exactly as the native
   tree's current row keeps it. */
.mrfw-ftRow[data-files-current],
.mrfw-ftRow[data-files-current]:hover {
  background: var(--dsw-alias-interactive-bg-active);
}

/* ── files-tree fork (verbatim rules, renamed classes) ─────────────────────
   Copied from upstream's FilesBody.module.css and FileTree.module.css
   (ui-sidebar-files @ 0.2.2-rc.5, unchanged since rc.3) with local names mapped to mrfw-ft* so the
   rules cannot collide with host DOM — and so the fork's own body (which must
   NOT carry data-files-body) stays visible while the rules above hide the
   native one. The header-only rules (root/header/path/tool/status/statusLine/
   titleIcon) belong to the upstream shell this fork drops and are not mapped.
   The tree's hidden, inactive, and match rules arrived with 0.2.2-rc.2's
   search. Fork sync re-diffs the upstream files and re-applies the rename —
   see src/client/files-tree/FORK.md. */

/* The pane's own .root already supplies the flex column, color, and font;
   the fork's body takes the same stretch item the hidden native body held,
   including the workspace list's 2px scrollbar offset and stable gutter. */
.mrfw-ftBody {
  flex: 1 1 auto;
  min-height: 0;
  margin-right: 2px;
  padding: 8px 0 8px 8px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.mrfw-ftBody::-webkit-scrollbar-track {
  margin: 2px;
}

.mrfw-ftLevel {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mrfw-ftLevel .mrfw-ftLevel {
  padding-left: 18px;
}

.mrfw-ftItem {
  margin: 0;
  padding: 0;
}

/* Rows abut, so the hover fill is the whole row; the tree's air is this
   inset, not a gap between rows. */
.mrfw-ftRow {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 5px 10px;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
}

@media (hover: hover) {
  .mrfw-ftRow:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

/* The folder glyph rides the tertiary ink, as the workspace tree's does. */
.mrfw-ftIcon {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
}

/* The type's coloured sheet at the folder glyph's 16px; its colour is its own. */
.mrfw-ftFileIcon {
  flex: 0 0 auto;
}

.mrfw-ftName {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* An entry the caller marks hidden: subdued, with the secondary ink that stays
   readable in both themes (upstream FileTree .hidden). */
.mrfw-ftHidden {
  color: var(--dsw-alias-label-secondary);
}

/* Neither a file nor a directory: shown so the directory is reported whole,
   greyed so nobody tries to open it. */
.mrfw-ftOther {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

/* A refused row never lights up on hover (upstream FileTree .inactive);
   .mrfw-ftOther is this fork's legacy spelling of that same row. */
@media (hover: hover) {
  .mrfw-ftInactive:hover,
  .mrfw-ftOther:hover {
    background: transparent;
  }
}

.mrfw-ftNote {
  margin: 0;
  padding: 3px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

/* The occurrences of the highlighted search text in a name (upstream FileTree
   .match): the business-primary ink on the row's own fill. */
.mrfw-ftMatch {
  color: var(--dsw-alias-state-business-primary);
  background: transparent;
}

/* ── files search fork (upstream 0.2.2-rc.2 rules, renamed classes) ────────
   Upstream 0.2.2-rc.2 added workspace search to the Files navigator: a bar
   above the tree, its result status, the results' notes, and a floating
   settings panel for the exclusion rules. Copied from upstream's
   FilesBody.module.css (ui-sidebar-files @ 0.2.2-rc.5, unchanged since rc.3) with local names
   mapped to mrfw-fs* so the rules cannot collide with host DOM. The pane
   wrapper is ours — the native navigator that supplied the column and the
   bar-height variable is not forked — and the fork reuses mrfw-ftBody for
   the scrolling result body. Fork sync re-diffs the upstream file and
   re-applies the rename — see src/client/files-tree/FORK.md. */

/* The forked pane around the search bar, status, results, and settings: the
   native navigator's column context and stretch item, plus the bar height the
   floating settings panel is placed against. It is positioned so that panel
   anchors to the pane exactly as upstream's .settings anchors to the
   navigator. */
.mrfw-fsPane {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  --files-search-bar-height: 42px;
}

/* "No matches" with the information button whose tooltip names the filters. */
.mrfw-fsEmptyNote {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* The information button keeps the note's line height. */
.mrfw-fsInfoBtn {
  flex: none;
  width: 20px;
  height: 20px;
  margin-block: -2px;
  padding: 0;
  color: var(--dsw-alias-label-caption);
}

/* The results status between the bar and the results: the count, and a spinner
   while a search is under way. */
.mrfw-fsStatus {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  min-height: 18px;
  margin: 0;
  padding: 2px 18px 0;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}

/* One sentence of the results status: the count. */
.mrfw-fsStatusLine {
  display: block;
  min-width: 0;
}

.mrfw-fsSpinner {
  flex: none;
}

/* A failed search in the results' place: the reason, and the retry control
   below it on the note's inset. */
.mrfw-fsFailure {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  padding-bottom: 6px;
}

.mrfw-fsRetry {
  margin-left: 10px;
}

/* The .gitignore choice above the add field, at a rule's height. */
.mrfw-fsSettingsOption {
  border-top: none;
}

/* The live region stays mounted while the query is blank, without taking
   room. */
.mrfw-fsStatusIdle {
  min-height: 0;
  padding: 0;
}

/* The settings panel floats over the tree below the search bar, inside the
   pane. */
.mrfw-fsSettings {
  position: absolute;
  top: var(--files-search-bar-height);
  right: 8px;
  bottom: 8px;
  left: 8px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 6px 4px 6px 10px;
  background: var(--dsw-alias-bg-base);
  border-radius: var(--dsw-radius-lg);
  outline: none;
  box-shadow: var(--dsw-elevation-prominent);
}

.mrfw-fsSettingsHeader {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  align-items: center;
}

.mrfw-fsSettingsTitle {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 500;
}

.mrfw-fsSettingsDesc {
  flex: 0 0 auto;
  margin: 0 0 4px;
  padding-right: 6px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}

/* The search bar above the tree: the settings control, the field, the
   hidden-entry control, and the clear control in one bordered box, drawn like
   the shared Input atom. */
.mrfw-fsBar {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: var(--files-search-bar-height);
  padding: 8px 8px 4px;
}

.mrfw-fsField {
  display: flex;
  gap: 2px;
  align-items: center;
  box-sizing: border-box;
  height: 100%;
  padding: 0 2px;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
}

.mrfw-fsField:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
}

/* The settings panel's header controls: the navigator's icon-button recipe
   (28px hit area around a 15px glyph, secondary voice, hover fill). */
.mrfw-fsToolBtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}

.mrfw-fsToolBtn svg {
  width: 15px;
  height: 15px;
}

@media (hover: hover) {
  .mrfw-fsToolBtn:hover {
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.mrfw-fsToolBtn[aria-pressed='true'],
.mrfw-fsToolBtn[aria-expanded='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The bar's icon controls: the header tool at a size that fits inside the
   field. */
.mrfw-fsTool {
  width: 24px;
  height: 24px;
  padding: 4px;
}

.mrfw-fsTool svg {
  width: 14px;
  height: 14px;
}

.mrfw-fsInput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 4px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  background: transparent;
  border: none;
  outline: none;
}

.mrfw-fsInput::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

/* The bar's own clear control replaces the browser's. */
.mrfw-fsInput::-webkit-search-cancel-button {
  display: none;
}

/* One rule, and the add field above them at the same height. */
.mrfw-fsRule {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  box-sizing: border-box;
  min-height: 32px;
  margin: 0;
  padding: 0 0 0 2px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}

.mrfw-fsAddRule {
  padding-right: 6px;
}

/* The add row's plus glyph rides the tertiary ink, as the tree's folder glyph
   does. */
.mrfw-fsAddRule .mrfw-fsIcon {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
}

/* The add field draws no box of its own, so its row's rule marks where typing
   goes. */
.mrfw-fsAddRule:focus-within {
  border-top-color: var(--dsw-alias-state-business-primary);
}

.mrfw-fsRuleInput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  background: transparent;
  border: none;
  outline: none;
}

.mrfw-fsRuleInput::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

.mrfw-fsSettingsError {
  flex: 0 0 auto;
  margin: 0 0 4px;
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xxs-12);
}

/* Only the list scrolls; the header and the add field stay put. */
.mrfw-fsRules {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
}

.mrfw-fsRuleLabel {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
  cursor: pointer;
}

.mrfw-fsRuleCheck {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0 1px;
  accent-color: var(--dsw-alias-state-business-primary);
}

.mrfw-fsRuleCheck:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.mrfw-fsRuleName {
  min-width: 0;
  padding: 6px 0;
  overflow-wrap: anywhere;
}

/* A rule the reader turned off stays listed, in the tertiary ink. */
.mrfw-fsRuleOff .mrfw-fsRuleName {
  color: var(--dsw-alias-label-tertiary);
}

/* Coarse pointers: bigger targets, a taller bar, and a 16px field so mobile
   browsers do not zoom the page when the field takes focus. */
@media (pointer: coarse) {
  .mrfw-fsTool {
    width: 32px;
    height: 32px;
  }

  .mrfw-fsPane {
    --files-search-bar-height: 50px;
  }

  .mrfw-fsRule {
    min-height: 44px;
  }

  .mrfw-fsInput,
  .mrfw-fsRuleInput {
    font-size: 16px;
  }
}

/* ── open-in-app fork (verbatim rules, renamed classes) ───────────────────
   Copied from upstream's OpenTargetButton.module.css
   (dsh-client-ui-open-in-app @ 0.2.1-alpha.2) with local names mapped to
   mrfw-open* so the rules cannot collide with host DOM. Fork sync re-diffs
   the upstream file and re-applies the rename — see
   src/client/open-in-app/FORK.md. */

/* Sized to sit in the document header's 24px control row beside its round
   icon buttons: a hairline pill with a 12px label and a narrow chevron half. */
.mrfw-openMenuAnchor {
  display: inline-flex;
  flex: none;
  align-self: center;
}

.mrfw-openSplit {
  display: inline-flex;
  align-items: stretch;
  box-sizing: border-box;
  height: 24px;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  font-family: var(--dsw-font-family);
}

.mrfw-openMain,
.mrfw-openChevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}

.mrfw-openMain {
  gap: 4px;
  padding: 3px 5px;
}

.mrfw-openChevron {
  padding: 3px 4px 3px 3px;
  border-left: 0.5px solid var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-secondary);
}

.mrfw-openMain:hover:not(:disabled),
.mrfw-openMain:focus-visible,
.mrfw-openChevron:hover:not(:disabled),
.mrfw-openChevron:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* Pending disables clicks without a restyle; only hover feedback pauses. */
.mrfw-openMain:disabled,
.mrfw-openChevron:disabled {
  cursor: default;
}

.mrfw-openAppIcon {
  object-fit: contain;
}

/* The unavailable preview emphasizes the same actions with a labeled button. */
.mrfw-openSplit[data-size='large'] {
  height: 36px;
  border-radius: var(--dsw-radius-md);
  border-color: var(--dsw-alias-border-l2);
}

.mrfw-openSplit[data-size='large'] .mrfw-openMain {
  gap: 6px;
  padding: 6px 14px;
  font-size: 14px;
}

.mrfw-openSplit[data-size='large'] .mrfw-openChevron {
  padding: 6px 10px;
}

.mrfw-openSkeleton { display: inline-block; flex: none; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-interactive-bg-hover); }

.mrfw-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.mrfw-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}

.mrfw-dialog {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: 100%;
  overflow: hidden;
  border: none;
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  outline: none;
}

.mrfw-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 22px 14px 12px 24px;
}

.mrfw-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 24px;
}

.mrfw-alert {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-state-error-primary);
}

.mrfw-section {
  display: flex;
  flex-direction: column;
}

.mrfw-section + .mrfw-section {
  margin-top: 8px;
}

.mrfw-sectionTitleRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 0 4px;
}

.mrfw-sectionTitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-sectionNote {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* A section title that also seats one trailing action (the worktree batch
   cleanup): the action right-aligns on the title's baseline row, and the row
   wraps — action onto the next line — instead of overflowing when the dialog
   is narrow. Only the section that carries an action uses this modifier. */
.mrfw-sectionTitleRowAction {
  flex-wrap: wrap;
}

.mrfw-sectionAction {
  margin-left: auto;
  align-self: center;
  display: inline-flex;
}

.mrfw-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.mrfw-rowBare {
  border-bottom: none;
}

/* A root entry's two lines: the display name on top, the absolute path under
   it in the tertiary voice (the workspace rows recipe of the host sidebar). */
/* Match upstream General Settings' DeveloperToolsRow layout. */
.mrfw-skillsSettings {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.mrfw-skillsSettingsText { min-width: 0; }
.mrfw-settingsTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mrfw-skillsSettingsTitle { font-size: 14px; line-height: 20px; }
.mrfw-skillsSettingsDescription {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.mrfw-rootText {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* Keep status tags and permission glyphs visible beside the alias, wrapping
   onto another line when the dialog is narrow. */
.mrfw-rootName {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-rootNameText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-rootPath {
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
  color: var(--dsw-alias-label-tertiary);
}

/* The path doubles as the copy control: an unstyled button that keeps the
   text recipe and makes the whole string clickable — the whole region, not
   just the icon, copies on click. */
.mrfw-pathCopy {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

/* The trailing icon stays in flow but invisible until the path is hovered
   or focused: appearing never re-wraps the text, and the icon inherits the
   path's own tertiary ink. */
.mrfw-pathCopyIcon {
  display: inline-flex;
  margin-left: 4px;
  vertical-align: -2px;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-pathCopy:hover .mrfw-pathCopyIcon,
.mrfw-pathCopy:focus-visible .mrfw-pathCopyIcon {
  opacity: 1;
}

.mrfw-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* The worktree Dialog: wider than the primitive's default card so a name,
   path, branch and access selector share one continuous row. */
.mrfw-worktreeDialog {
  width: min(860px, 100%);
  max-height: min(760px, 100%);
}

/* The candidate list: a continuous list with hairline separators, matching the
   Workspace Folders panel's additional-root rows. */
.mrfw-worktreeList {
  display: flex;
  flex-direction: column;
  max-height: min(56vh, 460px);
  overflow-y: auto;
}

.mrfw-worktreeRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.mrfw-worktreeRow:last-of-type { border-bottom: none; }

.mrfw-worktreeRowMain {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  cursor: pointer;
}

.mrfw-worktreeRowMain input { flex: none; }

.mrfw-worktreeRowText {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mrfw-worktreeRowNameLine {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.mrfw-worktreeRowName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-worktreeKind {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* The detected branch is metadata, not an action: a quiet compact chip beside
   the folder name. */
.mrfw-worktreeBranch {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
}

/* The per-row access selector keeps the panel's access vocabulary; its label
   yields before the name/path column. */
.mrfw-worktreeAccess {
  flex: none;
  max-width: 180px;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-worktreeAccessLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-worktreeRow .mrfw-rootPath { overflow-wrap: anywhere; }

.mrfw-worktreeRowNote { display: block; }

.mrfw-worktreeRowError {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-primary);
}

@media (max-width: 640px) {
  .mrfw-worktreeRow { grid-template-columns: minmax(0, 1fr); }
  .mrfw-worktreeAccess { justify-self: start; margin-left: 26px; }
  .mrfw-worktreeRowError { grid-column: 1; }
}

.mrfw-stateWarn {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-primary);
}

.mrfw-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-btn[aria-busy='true'] {
  cursor: wait;
}

.mrfw-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.mrfw-btnGhost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-btnGhost:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}

/* The solid destructive action of the capsule family: the upgrade confirm's
   red button. state-error-primary is the error ink upstream also uses as a
   fill (StateDot); the hover mixes in the host's primary label token to
   follow its theme and contrast choices. Neither color is a guessed token:
   an undefined var() would fall back
   to transparent and white-out the whole button. */
.mrfw-btnDanger {
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

.mrfw-btnDanger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, var(--dsw-alias-label-primary));
}

.mrfw-btnOutline {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
}

.mrfw-btnOutline:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-btnPrimary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

.mrfw-btnPrimary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}

/* One icon-only action: a square of the capsule family, meaning in title.
   Declared after the .mrfw-btn family so its padding wins the cascade tie:
   the capsule's 0 10px padding would otherwise squeeze the icon glyph. */
.mrfw-iconBtn {
  width: 28px;
  padding: 0;
  border-radius: 8px;
}

.mrfw-input {
  flex: 1 1 220px;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  outline: none;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}

.mrfw-input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

.mrfw-inputInline {
  flex: 1 1 auto;
}

.mrfw-accessSelect {
  flex: 0 0 auto;
}

/* The access dropdown's capsule trigger: the Menu anchor wrapper is the flex
   item, the button inside keeps the control row's 32px capsule recipe. */
.mrfw-accessTrigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  cursor: pointer;
}

.mrfw-accessTrigger:disabled {
  opacity: 0.5;
  cursor: default;
}

.mrfw-cwdTag {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
}

.mrfw-accessBadge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mrfw-accessBadge {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-aliasEditor {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-basis: 100%;
}

.mrfw-actions {
  display: flex;
  /* One control row by default: the manual path field is the only flexible
     item and absorbs the spare width first. Wrapping is kept because the
     root-limit hint claims a line of its own, and because the ≤560px dialog
     still needs the controls to reflow instead of overflowing. */
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

/* The root-limit hint fills one line above the controls row, so the controls
   start on the line after it — both stay below the divider above. */
.mrfw-actionsNote {
  flex: 0 0 100%;
}

/* One control row, one height: the capsule buttons match the 32px input. */
.mrfw-actions .mrfw-btn {
  height: 32px;
  border-radius: 16px;
}

.mrfw-actions .mrfw-iconBtn {
  width: 32px;
}

/* The add button is the row's primary control: it stretches to the worktree
   button so the row reads as one add affordance plus its satellite. */
.mrfw-addWrap,
.mrfw-addBtn {
  flex: 1 1 auto;
  display: flex;
}

.mrfw-addBtn {
  align-items: center;
  justify-content: center;
  min-width: 64px;
}

.mrfw-addWrap {
  position: relative;
}

.mrfw-addWrap .mrfw-addBtn {
  flex: 1 1 auto;
}

/* The add trust dialog: the named path on its own row, the access picker on
   the next. */
.mrfw-trustPath {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
  font-family: var(--dsw-font-mono, monospace);
  font-size: 12px;
  word-break: break-all;
}

.mrfw-trustAccess {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mrfw-trustAccessLabel {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

/* The guided-flow shell: a wide card with a step rail on the left. */
.mrfw-wizCard {
  position: relative;
  display: flex;
  width: min(720px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 48px));
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 40px rgba(0, 0, 0, 0.24));
  overflow: hidden;
  outline: none;
}

.mrfw-wizGrid {
  display: grid;
  grid-template-columns: 180px 1fr;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}

.mrfw-wizRail {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 16px;
  border-inline-end: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-base));
}

.mrfw-wizTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

.mrfw-wizSteps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mrfw-wizStep {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-radius: var(--dsw-radius-md);
}

.mrfw-wizDot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l2);
}

.mrfw-wizDot[data-state='current'] {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

.mrfw-wizDot[data-state='done'] {
  border-color: transparent;
}

.mrfw-wizStepTitle {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-wizStep[data-state='current'] .mrfw-wizStepTitle {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.mrfw-wizStep[data-state='done'] .mrfw-wizStepTitle {
  color: var(--dsw-alias-label-secondary);
}

.mrfw-wizMain {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* A fixed header strip owns the close control so it never overlaps the
   scrollable step content underneath it. */
.mrfw-wizHead {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding: 10px 12px 0;
}

.mrfw-wizBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 20px 12px;
}

.mrfw-wizFoot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.mrfw-wizActions {
  display: flex;
  gap: 8px;
}

.mrfw-wizStack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mrfw-wizField {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mrfw-wizFieldPair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* The endpoint line in ssh-target shape: a user field, the @ separator, the
   hostname taking the spare width, then the : separator and a short port. */
.mrfw-wizTargetRow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.mrfw-wizTargetRow .mrfw-wizField {
  min-width: 0;
}

.mrfw-wizTargetUser {
  flex: 0 1 104px;
}

.mrfw-wizTargetHost {
  flex: 1 1 auto;
}

.mrfw-wizTargetPort {
  flex: 0 0 68px;
}

.mrfw-wizTargetSep {
  flex: none;
  /* 24px clears the field label so the separator lands on the input line. */
  margin-top: 24px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 32px;
}

.mrfw-wizFieldLabel {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-wizFieldHint {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-wizField[data-invalid='true'] .mrfw-wizFieldHint {
  color: var(--dsw-alias-state-error-primary);
}

.mrfw-wizSection {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-interactive-bg-hover));
}

.mrfw-wizCheck {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mrfw-wizCheckRow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.mrfw-wizCheckHint {
  padding-inline-start: 24px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-checkRow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}

/* The selectable row: icon, a title/subtitle stack, and a trailing status. */
.mrfw-choice {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

button.mrfw-choice:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-choice.mrfw-choiceOn {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary) inset;
}

.mrfw-choice:disabled {
  opacity: 0.55;
  cursor: default;
}

.mrfw-choiceIcon {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-choiceText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.mrfw-choiceTitle {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
}

.mrfw-choiceSub,
.mrfw-choiceHint {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-choiceTrail {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

/* One readiness line inside the environment step. */
.mrfw-checkItem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
}

.mrfw-checkDot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
}

.mrfw-checkDotFallback {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-state-success-primary);
  font-size: 9px;
  line-height: 10px;
  text-align: center;
}

.mrfw-checkDotFallback[data-state='done'] {
  border-color: var(--dsw-alias-state-success-primary);
}

.mrfw-checkDotFallback[data-state='warning'] {
  border-color: var(--dsw-alias-state-warn-primary);
}

.mrfw-checkDotFallback[data-state='error'] {
  border-color: var(--dsw-alias-state-error-primary);
}

.mrfw-checkText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.mrfw-checkLabel {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}

.mrfw-checkDetail {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-checkAction {
  flex: none;
  display: inline-flex;
  align-items: center;
}

.mrfw-wizKeys {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mrfw-wizFingerprint {
  font-family: var(--dsw-font-mono, monospace);
}

.mrfw-wizPicker,
.mrfw-wizPickerCompact {
  flex: none;
  display: inline-flex;
}

.mrfw-wizPicker {
  flex: 1 1 auto;
}

.mrfw-wizPickerBtn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  cursor: pointer;
}

.mrfw-wizPickerFull {
  flex: 1 1 auto;
  justify-content: space-between;
}

.mrfw-wizPickerLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The browse dialog's own column: path bar, status line, then the floating
   directory rows — spaced like the host directory browser so nothing glues. */
.mrfw-wizBrowse {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

/* The directory column floats on the card (no boxed list): 2px row gaps, a
   scrollbar lane on the right — the host browser's row form. */
.mrfw-wizDirList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 8px;
}

.mrfw-wizDirRow {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 28px;
  padding: 4px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  text-align: start;
  cursor: pointer;
}

.mrfw-wizDirRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-wizDirIcon {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-wizDirName {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-wizDirArrow {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-wizSummary {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 14px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-interactive-bg-hover));
}

.mrfw-wizSummaryRow {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 12px;
  font-size: 12px;
}

.mrfw-wizSummaryRow dt {
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-wizSummaryRow dd {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}

.mrfw-wizDone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
}

.mrfw-wizDoneMark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-wizDoneTitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.mrfw-wizEmpty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.mrfw-subsection {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
}

.mrfw-sshArea {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mrfw-sshDialog {
  width: min(760px, 100%);
  max-height: calc(100vh - 48px);
}

.mrfw-sshDialogContent {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Follow the host SettingsRoot grid and ModelsSection surface tokens. */
.mrfw-sshSettingsOverlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
}

.mrfw-sshSettingsMask {
  position: absolute;
  inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}

.mrfw-sshSettingsDialog {
  position: relative;
  box-sizing: border-box;
  width: min(800px, calc(100vw - 48px));
  height: min(800px, calc(100dvh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
  overflow: hidden;
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

.mrfw-sshSettingsDialog:focus {
  outline: none;
}

.mrfw-sshSettingsGrid {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "title header" "nav pane";
  min-height: 0;
}

.mrfw-sshSettingsDialog > .mrfw-pendingBar,
.mrfw-sshSettingsFallback .mrfw-pendingBar {
  position: absolute;
  inset-inline: 0;
}

.mrfw-sshSettingsTitle {
  grid-area: title;
  min-width: 0;
  margin: 0;
  padding: 22px 12px 8px 24px;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.mrfw-sshSettingsHeader {
  grid-area: header;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 20px 14px 6px;
}

.mrfw-sshSettingsClose {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

.mrfw-sshSettingsNav {
  grid-area: nav;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  padding: 10px 12px 0;
  overflow-y: auto;
}

.mrfw-sshSettingsNavItem {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 40px;
  min-width: 0;
  padding: 0 16px 0 12px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: start;
  cursor: pointer;
}

.mrfw-sshSettingsNavItem svg {
  flex: none;
}

.mrfw-sshSettingsNavItem span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-sshSettingsClose:hover,
.mrfw-sshSettingsNavItem:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-sshSettingsNavItem[aria-current='true'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover));
}

.mrfw-sshSettingsClose:focus-visible,
.mrfw-sshSettingsNavItem:focus-visible,
.mrfw-sshSettingsAdd:focus-visible,
.mrfw-sshSettingsCard .mrfw-iconBtn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

.mrfw-sshSettingsPane {
  grid-area: pane;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 24px 24px;
}

.mrfw-sshSettingsHeading {
  display: grid;
  gap: 12px;
  margin-block-end: 24px;
}

.mrfw-sshSettingsHeading h3 {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-sshSettingsHeading p {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}

/* Older hosts provide Modal without the layer hook. Keep its built-in chrome. */
.mrfw-sshSettingsFallback,
.mrfw-sshSettingsFallback > :has(> .mrfw-sshSettingsGrid) {
  flex: 1 1 auto;
  min-height: 0;
}

.mrfw-sshSettingsFallback > :has(> .mrfw-sshSettingsGrid) {
  margin: 0;
  padding: 0;
}

.mrfw-sshSettingsFallback .mrfw-sshSettingsGrid {
  flex: 1 1 auto;
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: "nav pane";
}

.mrfw-sshSettingsInventory,
.mrfw-sshSettingsList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mrfw-sshSettingsList {
  list-style: none;
  padding: 0;
  margin: 0;
}

.mrfw-sshSettingsCard {
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4));
  border-radius: var(--dsw-radius-xl, 20px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2));
}

.mrfw-sshSettingsCardMain,
.mrfw-sshSettingsCardActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.mrfw-sshSettingsCardMain {
  gap: 10px 16px;
}

.mrfw-sshSettingsCardText {
  display: flex;
  flex: 1 1 14rem;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mrfw-sshSettingsCardTitle,
.mrfw-sshSettingsFacts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.mrfw-sshSettingsCardTitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-sshSettingsCardActions {
  justify-content: flex-end;
  gap: 4px;
  max-width: 100%;
  margin-inline-start: auto;
}

.mrfw-sshSettingsIdentifier,
.mrfw-sshSettingsFacts {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-sshSettingsIdentifier {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}

.mrfw-sshConnectionStatus {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}

.mrfw-sshConnectionStatus[data-ready='true'] {
  background: var(--dsw-alias-state-success-primary);
}

.mrfw-sshSettingsAdd.mrfw-sshButton {
  width: 100%;
  min-height: 44px;
  height: auto;
  padding: 8px 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg, 16px);
  background: transparent;
  box-shadow: none;
}

.mrfw-sshSettingsAdd .mrfw-btnLabel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  white-space: normal;
}

.mrfw-sshSettingsAdd:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-sshSettingsInventory button[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-sshSettingsCard .mrfw-iconBtn {
  border-radius: var(--dsw-radius-sm);
}

.mrfw-sshSettingsCard .mrfw-sshDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.mrfw-sshSettingsCard > .mrfw-sshEnvExtra {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}

.mrfw-sshSettingsCard > .mrfw-sshEdit {
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
}

.mrfw-sshSettingsCard .mrfw-sshEdit > .mrfw-sshForm {
  border: 0;
  padding: 0;
}

@media (max-width: 767px) {
  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsOverlay {
    background: var(--dsw-alias-bg-layer-2);
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsOverlay > .mrfw-sshSettingsDialog {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsGrid {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "title header" "nav nav" "pane pane";
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsFallback .mrfw-sshSettingsGrid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: "nav" "pane";
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsTitle {
    padding: 22px 0 0 16px;
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsHeader {
    padding: 20px 16px 0 10px;
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsNav {
    flex-direction: row;
    padding: 12px 16px 14px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsNavItem {
    flex: 1 0 auto;
    justify-content: center;
    min-width: 108px;
    padding: 0 14px;
  }

  html:not([data-windows-titlebar]):not([data-platform='darwin']) .mrfw-sshSettingsPane {
    padding: 0 16px 24px;
  }
}

.mrfw-sshStep {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.mrfw-sshStep:first-child {
  padding-top: 0;
  border-top: none;
}

.mrfw-sshStepTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-sshForm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}

.mrfw-sshEdit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* The old panel class was designed for horizontal rows: flex-basis 220px is
   a width there, but a height basis in a column. Keep it from ever stretching
   a control inside the dialog forms. */
.mrfw-sshForm .mrfw-input {
  flex: 0 0 auto;
  width: 100%;
}

.mrfw-sshGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.mrfw-sshField {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mrfw-sshFieldWide {
  grid-column: 1 / -1;
}

.mrfw-sshFieldInvalid .mrfw-sshInput {
  border-color: var(--dsw-alias-state-error-primary);
}

.mrfw-sshFieldInvalid .mrfw-sshPickerTrigger {
  --dsh-button-outline-color: var(--dsw-alias-state-error-primary);
}

.mrfw-sshTargetRow {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.mrfw-sshTargetRow .mrfw-sshField {
  min-width: 0;
}

.mrfw-sshTargetUser {
  flex: 0 1 160px;
}

.mrfw-sshTargetHost {
  flex: 1 1 auto;
}

.mrfw-sshTargetPort {
  flex: 0 0 92px;
}

.mrfw-sshTargetSep {
  flex: none;
  align-self: flex-end;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 32px;
}

.mrfw-sshTag {
  flex: none;
}

.mrfw-sshFieldLabel {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-sshFieldHint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-sshInput,
.mrfw-sshHelperInput,
.mrfw-teamInput,
button.mrfw-sshButton {
  box-sizing: border-box;
  height: 32px;
}

.mrfw-sshInput {
  display: flex;
  width: 100%;
}

.mrfw-sshPicker,
button.mrfw-sshPickerTrigger {
  width: 100%;
  min-width: 0;
}

button.mrfw-sshPickerTrigger {
  justify-content: space-between;
}

.mrfw-sshPickerLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-sshPickerTrigger svg,
.mrfw-sshPickerCompact {
  flex: none;
}

.mrfw-sshAliasInput {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mrfw-sshAliasInput > .mrfw-sshInput {
  min-width: 0;
}

.mrfw-sshTextarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 72px;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: monospace;
  font-size: 13px;
  line-height: 20px;
  outline: none;
  resize: vertical;
}

.mrfw-sshTextarea:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.mrfw-sshCheckRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
}

.mrfw-sshCheckbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

.mrfw-sshCheckbox input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: inherit;
}

.mrfw-sshRadioGroup {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.mrfw-sshRadioOption {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

.mrfw-sshRadioOption input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: inherit;
}

.mrfw-sshInlineNote {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mrfw-sshTransferRow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mrfw-sshTransferPeer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.mrfw-sshDanger:is(.mrfw-sshButton, .mrfw-iconBtn) {
  color: var(--dsw-alias-state-error-primary);
}

.mrfw-sshHelperRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.mrfw-sshHelperInput {
  display: flex;
  flex: 0 1 auto;
  width: 240px;
  max-width: 100%;
}

.mrfw-teamInput {
  display: flex;
  width: 100%;
}

@media (max-width: 640px) {
  .mrfw-sshGrid {
    grid-template-columns: 1fr;
  }

  .mrfw-sshFieldWide {
    grid-column: auto;
  }
}

.mrfw-sshRowActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mrfw-sshBindingList > .mrfw-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.mrfw-sshBindingList .mrfw-sshRowActions {
  flex-wrap: nowrap;
}

.mrfw-sshBindingList .mrfw-accessBadge {
  min-width: 0;
  max-width: 100%;
}

.mrfw-sshBindingList .mrfw-accessBadge svg {
  flex: none;
}

.mrfw-sshBindingList .mrfw-note {
  overflow-wrap: anywhere;
}

.mrfw-sshAddRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mrfw-sshScanRow {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mrfw-sshPathBar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mrfw-sshPathBar .mrfw-sshInput {
  flex: 1 1 8rem;
  min-width: 0;
}

.mrfw-sshPathBar > :is(.mrfw-sshRowActions, .mrfw-sshButton) {
  margin-inline-start: auto;
}

.mrfw-sshDirList {
  display: flex;
  flex-direction: column;
  max-height: 280px;
  overflow-y: auto;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}

.mrfw-sshDirRow {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}

.mrfw-sshDirRow:last-child {
  border-bottom-color: transparent;
}

.mrfw-sshDirRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-sshDirRow:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}

.mrfw-sshDirName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-sshDirArrow {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-sshDialogFooterActions {
  justify-content: flex-end;
}

/* Nested decisions are narrower than the management card. */
.mrfw-sshPathDialog {
  width: min(620px, 100%);
  max-height: calc(100vh - 48px);
}

/* The worktree suggestion notice (ADR-0039 第二十一次修订): a persistent,
   non-modal card. The client computes the fixed seat; this sheet owns only the
   surface, the compact form, and the entrance fade. The surface follows the
   active theme on purpose: light mode gets a light card, dark mode a dark one. */
.mrfw-notice {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: max-content;
  max-width: var(--mrfw-notice-max-width, 560px);
  padding: 10px 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg, var(--dsw-radius-md));
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  pointer-events: auto;
  animation: mrfw-notice-fade 160ms ease-out;
  /* Both seats are horizontally centered: Hero on the composer, conversation
     on its content column. */
  transform: translateX(-50%);
}

.mrfw-notice[data-compact='true'] {
  flex-wrap: wrap;
  row-gap: 8px;
}

.mrfw-notice[data-compact='true'] .mrfw-noticeBody {
  flex-basis: 100%;
}

.mrfw-notice[data-compact='true'] .mrfw-noticeActions {
  flex-basis: 100%;
  justify-content: flex-end;
  margin-left: 0;
}

.mrfw-noticeBody {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mrfw-noticeIcon {
  display: flex;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

.mrfw-noticeText {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 22px;
}

.mrfw-noticeActions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.mrfw-noticeAction {
  flex: none;
}

/* Remind me later is one split control: the text half applies the default
   until-new-worktree delay, the chevron half opens the three choices. */
.mrfw-noticeSplit {
  display: inline-flex;
  flex: none;
  align-items: center;
  box-sizing: border-box;
  height: 28px;
  border-radius: var(--dsw-radius-sm);
  /* The hairline frame matches the divider between the two halves. */
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}

.mrfw-noticeSplit > * {
  display: inline-flex;
}

.mrfw-noticeSplitText {
  border-radius: var(--dsw-radius-sm) 0 0 var(--dsw-radius-sm);
}

.mrfw-noticeSplitToggle {
  width: 24px;
  padding: 0;
  border-left: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;
}

.mrfw-notice[data-compact='true'] .mrfw-noticeAction {
  height: 32px;
  padding: 0 12px;
}

.mrfw-notice[data-compact='true'] .mrfw-noticeSplit {
  height: 32px;
}

.mrfw-notice[data-compact='true'] .mrfw-noticeSplitToggle {
  width: 32px;
  padding: 0;
}

/* The close badge (ADR-0039 第二十五次修订): one small perfect circle parked on
   the card's top-right corner, half outside it. It is drawn here rather than
   with a primitive: the compact size rules fix a taller control and a smaller
   corner radius, so a primitive renders as a rounded rectangle. The badge keeps
   the card's own surface in every pointer state — it never gains a hover tint
   or becomes transparent. */
.mrfw-notice .mrfw-noticeClose {
  position: absolute;
  top: 0;
  right: 0;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  line-height: 0;
  cursor: pointer;
  /* Pulled 2px toward the card on both axes: a corner badge reads as balanced
     only when its optical seat sits slightly inside the geometric corner. */
  transform: translate(calc(50% - 2px), calc(-50% + 2px));
}

/* The circle stays 18px; this invisible ring widens the pointer target to 24px. */
.mrfw-notice .mrfw-noticeClose::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
}

/* The badge overhangs the card, so its focus ring may draw outside the surface. */
.mrfw-notice .mrfw-noticeClose:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

@keyframes mrfw-notice-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .mrfw-notice {
    animation: none;
  }
}

/* The reminder-delay dropdown: the same border/background/ink recipe as the
   text inputs, in the compact capsule height the notice's buttons use. */
.mrfw-select {
  box-sizing: border-box;
  height: 28px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  outline: none;
  cursor: pointer;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-select:focus {
  border-color: var(--dsw-alias-brand-primary);
}

.mrfw-select:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}


/* The Dialog footer: the reminder dropdown on the left, the two decisions on
   the right; both use the host's Button/Menu so heights match. */
.mrfw-worktreeFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.mrfw-worktreeFooterEnd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.mrfw-worktreeLater {
  gap: 4px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Pending feedback: spinner, status line, and the dialog progress bar. */
.mrfw-pendingSpinner {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
}

.mrfw-spinnerRing {
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: mrfw-spin 0.9s linear infinite;
}

@keyframes mrfw-spin {
  to { transform: rotate(360deg); }
}

.mrfw-doneDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
}

button.mrfw-sshButton {
  position: relative;
}

.mrfw-btnLabel {
  display: inline-flex;
  align-items: center;
  gap: inherit;
  transition: opacity 120ms var(--ds-ease-in-out);
}

.mrfw-btnLoading .mrfw-btnLabel {
  opacity: 0;
}

.mrfw-loadingSpinner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: mrfw-fade-in 120ms var(--ds-ease-in-out) both;
}

.mrfw-loadingSpinner > * {
  color: inherit;
}

.mrfw-sshButton[aria-busy='true'] {
  cursor: progress;
}

.mrfw-statusLine {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  animation: mrfw-status-in 180ms var(--ds-ease-in-out) 120ms both;
}

.mrfw-statusLine[data-state='done'] {
  animation-delay: 0s;
}

@keyframes mrfw-status-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}

@keyframes mrfw-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.mrfw-pendingBar {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 2px;
  margin-bottom: -2px;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transition: opacity 160ms var(--ds-ease-in-out);
}

.mrfw-pendingBar[data-active='true'] {
  opacity: 1;
  transition-delay: 120ms;
}

.mrfw-pendingBar::before {
  content: '';
  position: absolute;
  inset-block: 0;
  left: 0;
  width: 40%;
  border-radius: 1px;
  background: var(--dsw-alias-brand-primary);
  transform: translateX(-100%);
}

.mrfw-pendingBar[data-active='true']::before {
  animation: mrfw-pending-slide 1.2s var(--ds-ease-in-out) infinite;
}

@keyframes mrfw-pending-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}

.mrfw-sshDirList {
  transition: opacity 160ms var(--ds-ease-in-out);
}

.mrfw-sshDirList[aria-busy='true'] {
  opacity: 0.55;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .mrfw-spinnerRing,
  .mrfw-statusLine,
  .mrfw-loadingSpinner,
  .mrfw-pendingBar[data-active='true']::before {
    animation: none;
  }

  .mrfw-pendingBar::before {
    width: 100%;
    transform: none;
    opacity: 0.6;
  }

  .mrfw-btnLabel,
  .mrfw-pendingBar {
    transition: none;
  }
}
`
