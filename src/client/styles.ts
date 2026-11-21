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
  /* The dialog caps against the window, not only against the padded overlay:
     a long additional-root list must stop at 80% of the viewport, while the
     100% floor keeps the overlay's 24px air on a viewport shorter than the
     fixed header, primary row and add row. An elevated surface rebinds the
     host scrollbar skin to its l2 tokens (host Modal/Menu recipe). */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: 100%;
  max-height: min(80vh, 100%);
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

/* The scroll region is the additional-root list; this body scroll is only the
   fallback for a viewport too short to hold the header, the primary row and
   the add row, so those controls are never clipped. */
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
  flex: none;
}

.mrfw-section + .mrfw-section {
  margin-top: 8px;
}

/* The additional-root section yields height first when the dialog reaches its
   cap; its title row and batch action stay outside the scrolling row list. */
.mrfw-sectionAdditional {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* The panel's only normal scroll region. The rows are the variable part, so
   they take the space left below the fixed sections, capped relative to the
   window (never a pixel height), and scroll in place. Contain keeps a wheel
   gesture at either end from moving the page behind the dialog. */
.mrfw-rootList {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 60vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
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
  padding: 0 12px;
}

.mrfw-cwdTag {
  flex: none;
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
  flex: none;
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

/* The manual path field absorbs the row's spare width and gives way first. */
.mrfw-manualPath {
  flex: 1 1 120px;
  min-width: 80px;
}

/* One control row, one height: the capsule buttons match the 32px input. */
.mrfw-actions .mrfw-btn {
  height: 32px;
  border-radius: 16px;
}

.mrfw-actions .mrfw-iconBtn {
  width: 32px;
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
`
