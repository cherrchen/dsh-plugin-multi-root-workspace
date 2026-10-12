/**
 * Fork-facing shim for upstream `OpenTargetButton.module.css`.
 *
 * This plugin's bundle has no CSS-module pipeline: the `<style>` element it
 * installs carries one flat sheet (`src/client/styles.ts`). The upstream
 * component reads `css.<name>` so the forked file needs one importable
 * module exporting that same key map — this file, reached through the
 * verbatim `./OpenTargetButton.module.css.ts` specifier (the one sanctioned
 * fork edit: the specifier gains the `.ts` this toolchain resolves
 * everywhere — tsc, tsdown, vitest). The specifier text is spelled without
 * its `import` clause on purpose: the packed-artifact check scans every
 * bundle comment too, and quoting the full statement would read as a
 * relative import the tarball does not carry.
 *
 * Each upstream local class maps to an `mrfw-open*` name so the copied
 * rules cannot collide with host DOM; the rules themselves live in
 * styles.ts verbatim apart from that rename. `data-open-target` and the
 * other data attributes are literals in the component and stay byte-exact.
 * See FORK.md.
 */

const css = {
  menuAnchor: 'mrfw-openMenuAnchor',
  split: 'mrfw-openSplit',
  main: 'mrfw-openMain',
  chevron: 'mrfw-openChevron',
  appIcon: 'mrfw-openAppIcon',
  skeleton: 'mrfw-openSkeleton',
} as const

export default css
