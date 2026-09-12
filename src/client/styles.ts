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
.mrfw-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 42px;
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
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mrfw-triggerIcon {
  flex: none;
  display: inline-flex;
}

.mrfw-triggerRail {
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
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

.mrfw-sectionTitle {
  padding: 8px 0 4px;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
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

.mrfw-path {
  flex: 1 1 240px;
  font-family: var(--ds-font-family-code);
  font-size: 13px;
  line-height: 20px;
  word-break: break-all;
  color: var(--dsw-alias-label-primary);
}

.mrfw-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.mrfw-alias {
  padding: 0 8px;
  border-radius: 11px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  font-style: normal;
  line-height: 22px;
  color: var(--dsw-alias-label-secondary);
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
`
