/**
 * Remove the JavaScript face of `lib/` before a build.
 *
 * tsdown is configured with `clean: false` on purpose — the host and client
 * configurations share `outDir: lib`, and the type declarations live in
 * `lib/types/` (written by `tsc` in a separate step), so a whole-directory
 * clean would make the two faces delete each other's output and take the
 * declarations with it.
 *
 * What still has to go is the *previous* build's JavaScript: shared chunks are
 * content-hashed, so a chunk whose content changed leaves its old name behind
 * forever. `files` publishes `lib/*.js`, which means `pnpm pack` — a documented
 * install path — would otherwise ship every historical chunk as unreferenced
 * dead code. CI never sees this (a clean checkout has no `lib/`), so it is
 * cleaned here rather than left to the environment.
 *
 * `lib/types/**\/*.d.ts` is deliberately untouched: it is produced before this
 * step by `build:types`, and `.d.ts` does not match the pattern below.
 *
 * @module scripts/clean-lib
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../lib/', import.meta.url))
const JAVASCRIPT_ARTIFACT = /\.js(\.map)?$/

let removed = 0
if (existsSync(OUT_DIR)) {
  for (const entry of readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !JAVASCRIPT_ARTIFACT.test(entry.name)) continue
    rmSync(join(OUT_DIR, entry.name), { force: true })
    removed += 1
  }
}
console.log(`[clean-lib] removed ${removed} JavaScript artifact(s); lib/types/ is left alone`)
