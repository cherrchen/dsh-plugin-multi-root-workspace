/**
 * Shim for the CSS-module virtual module `./FilesBody.module.css`.
 *
 * This toolchain resolves real files, not CSS-module virtual modules — so
 * the forked body imports this file instead (the one-line specifier delta
 * recorded in FORK.md). It exports the same `css.<name>` map, pointed at the
 * plugin-prefixed `mrfw-ft*` classes whose rules live in `styles.ts`; the
 * upstream `FilesBody.module.css` sits beside it verbatim as the diffable
 * source. Only the names the fork's JSX actually reads are mapped — the
 * header-only entries (`root`, `header`, `path`, `tool`, `status`,
 * `statusLine`, `titleIcon`) belong to the shell this fork drops.
 */
const css = {
  body: 'mrfw-ftBody',
  level: 'mrfw-ftLevel',
  item: 'mrfw-ftItem',
  row: 'mrfw-ftRow',
  icon: 'mrfw-ftIcon',
  fileIcon: 'mrfw-ftFileIcon',
  name: 'mrfw-ftName',
  other: 'mrfw-ftOther',
  note: 'mrfw-ftNote',
} as const

export default css
