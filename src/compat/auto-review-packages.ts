/**
 * Exact execution-copy check for the optional Auto Review fork.
 *
 * The fork value-imports these host packages, so the copies it would execute
 * must be the same exact release as the host: a private or mixed copy would
 * split runtime identity (the fixture base, the tool registry, the preset
 * service) that the reviewer depends on. Ordinary Multi-root keeps its broader
 * contract; only this optional integration is judged release by release.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/auto-review-packages
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Packages the fork imports for a value and would execute in-process. */
const EXECUTION_COPIES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-util-values',
] as const

/**
 * Assert every execution copy resolves to the installed host release.
 * @param release - the exact supported host release selected by the entry.
 * @throws when a copy is missing or reports a different version.
 */
export function assertForkPackages(release: string): void {
  const require = createRequire(import.meta.url)
  for (const name of EXECUTION_COPIES) {
    const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown }
    if (manifest.version !== release) {
      throw new Error(`multi-root Auto Review: incompatible execution copy of ${name} for DSH ${release}`)
    }
  }
}
