/** Exact fork execution copies; ordinary Multi-root keeps its broader contract. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
export function assertForkPackages(): void {
  const require = createRequire(import.meta.url)
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-permission-presets', '@deepseek-ai/dsh-util-values']) {
    const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'))
    if (manifest.version !== '0.2.1-rc.2') throw new Error(`multi-root Auto Review: incompatible execution copy of ${name}`)
  }
}
