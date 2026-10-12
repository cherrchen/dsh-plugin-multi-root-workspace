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
   visible, and the plugin's own tree is portaled in as the body's sibling.
   The header still offers a reload — the switcher's own .mrfw-switcherReload
   re-keys the portaled tree. The native tree keeps watching in the
   background, so switching back to the primary root restores it instantly. */
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-body],
[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-reload] {
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
   left-clip and hover-title behavior; only the gutters are ours. */
.mrfw-switcherPath {
  margin: 0 12px 0 4px;
}

/* The takeover's own reload, standing exactly where the hidden native one
   did: the upstream .tool recipe verbatim (28px hit area, 15px glyph,
   secondary voice, hover fills). It re-keys the portaled tree. */
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

/* The self-drawn additional-root tree, portaled into the pane as a sibling
   of the hidden native body. The pane is a vertical flex column whose body
   is the stretch item, so the same recipe makes this tree take over the
   vacated space and scroll its own overflow. */
.mrfw-switcherTree {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 8px;
}

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

.mrfw-description {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
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
.mrfw-rootText {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mrfw-rootName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.mrfw-rootPath {
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
  color: var(--dsw-alias-label-tertiary);
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

.mrfw-btnDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
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

.mrfw-accessBadge {
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

.mrfw-fileTree { flex-basis: 100%; min-width: 0; }
.mrfw-fileLevel { list-style: none; padding-left: 16px; margin: 4px 0; }
.mrfw-fileEntry { display: block; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; padding: 4px; overflow-wrap: anywhere; }
.mrfw-fileEntry:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary); }
.mrfw-filePreview { max-height: 320px; overflow: auto; padding: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; }
.mrfw-actions .mrfw-iconBtn {
  width: 32px;
}
`
