/**
 * Child process that holds the registry authority lease for the multiprocess
 * e2e. Protocol: argv is JSON `{ storeRoot, primary, extra?, hold }`; stdout
 * writes one JSON status line then waits on stdin until the parent closes it
 * or sends SIGKILL.
 */

import { mkdirSync } from 'node:fs'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { mountRegistryStack } from './registry-stack.ts'

interface ChildConfig {
  readonly storeRoot: string
  readonly primary: string
  readonly extra?: string
}

const config = JSON.parse(process.argv[2] ?? '{}') as ChildConfig
mkdirSync(config.storeRoot, { recursive: true })

const stack = await mountRegistryStack(config.storeRoot)
try {
  if (config.extra !== undefined) {
    await stack.registry.add(config.primary, { path: config.extra })
  }
  const granted = stack.registry.granted(config.primary)
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    pid: process.pid,
    authority: stack.registry.authority.kind,
    granted: granted.map(path => canonicalPath(path)),
  })}\n`)
  await new Promise<void>(resolve => {
    process.stdin.resume()
    process.stdin.on('end', () => resolve())
    process.stdin.on('error', () => resolve())
  })
} finally {
  await stack.dispose()
}
