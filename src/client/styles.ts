/**
 * The plugin's one stylesheet, injected into the document by the client entry.
 *
 * The host ships its design tokens as CSS custom properties on `body`
 * (`--dsw-alias-*` semantics, `--dsw-elevation-*` shadows, `--ds-*` motion and
 * code-font tokens), so this sheet names no color of its own: light and dark
 * theme follow the host automatically. The recipes mirror the native surfaces
 * this UI sits beside — the sidebar footer trigger, the Modal primitive, and
 * the capsule Button (ADR-0006 records the decision).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/styles
 */

/** The stylesheet text; every class is prefixed `mrfw-` to stay collision-free. */
export const STYLES = /* css */ `
/* Sidebar footer row, mirroring the host ui-settings-general trigger: the row
 * wrapper overhangs each side by 2px (width calc(100% + 4px) against the
 * shell's 12px inline padding) so the icon's ink line lands at 18px from the
 * column edge — exactly where the Settings gear below sits. */
.mrfw-triggerRow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  margin: 4px -2px;
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
  gap: 8px;
  width: auto;
  height: 42px;
  margin: 0;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-triggerIcon {
  flex: none;
  display: inline-flex;
}

.mrfw-triggerLabel {
  overflow: hidden;
  white-space: nowrap;
}

.mrfw-triggerRail {
  flex: none;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  gap: 0;
  border-radius: 50%;
  justify-content: center;
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
   never grows — the PathLabel after it owns the free header space. */
.mrfw-rootSwitchBtn {
  flex: 0 1 auto;
  min-width: 0;
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

.mrfw-rootSwitchLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrfw-rootSwitchChevron {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
}

/* The selected root's full path sits between the trigger and the reload —
   the very PathLabel upstream draws there, so it brings its own grow,
   left-clip and hover-title behavior; only the gutters are ours. The right
   margin plus the container gap reproduces upstream's .path margin-right
   12px + header gap 4px; the left gutter comes from the same container gap. */
.mrfw-switcherPath {
  margin: 0 12px 0 0;
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

/* ── files-tree fork (verbatim rules, renamed classes) ─────────────────────
   Copied from upstream's FilesBody.module.css (ui-sidebar-files @
   0.2.1-alpha.2) with local names mapped to mrfw-ft* so the rules cannot
   collide with host DOM — and so the fork's own body (which must NOT carry
   data-files-body) stays visible while the rules above hide the native one.
   The header-only rules (root/header/path/tool/status/statusLine/titleIcon)
   belong to the upstream shell this fork drops and are not mapped. Fork sync
   re-diffs the upstream file and re-applies the rename — see
   src/client/files-tree/FORK.md. */

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

.mrfw-ftRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
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

/* Neither a file nor a directory: shown so the directory is reported whole,
   greyed so nobody tries to open it. */
.mrfw-ftOther {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.mrfw-ftOther:hover {
  background: transparent;
}

.mrfw-ftNote {
  margin: 0;
  padding: 3px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
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
.mrfw-skillBody { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }
.mrfw-skillReference { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); border: none; cursor: pointer; font: inherit; }
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

/* One control row, one height: the capsule buttons match the 32px input. */
.mrfw-actions .mrfw-btn {
  height: 32px;
  border-radius: 16px;
}

.mrfw-actions .mrfw-iconBtn {
  width: 32px;
}
`
