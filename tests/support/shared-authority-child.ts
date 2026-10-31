/** NDJSON parent protocol. Each process mounts production storage, Registry and fs. */
import { createInterface } from 'node:readline'
import { wrapMethod } from '../../src/method-wrapper.ts'
import { join } from 'node:path'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import MultiRootFileSystem from '../../src/fs.ts'
import { mountRegistryStack } from './registry-stack.ts'
const { root, primary } = JSON.parse(process.argv[2]!) as { root: string; primary: string }
const stack = await mountRegistryStack(root, { sharedStorageRoot: root }, { beforeGate: async ctx => {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: primary })
  await ctx.plugin(MultiRootFileSystem, { cwd: primary })
} })
await stack.registry.refresh(primary)
process.stdout.write(JSON.stringify({ ready: true, authority: stack.registry.authority.kind, unavailable: stack.registry.unavailable }) + '\n')
let release: (() => void) | undefined
let captured: Promise<void> | undefined
const lines = createInterface({ input: process.stdin })
const send = (id: number, value: unknown, error?: unknown) => process.stdout.write(JSON.stringify({ id, value, ...(error === undefined ? {} : { error: String(error) }) }) + '\n')
const pending = new Set<Promise<unknown>>()
lines.on('line', line => {
  const { id, method, args = [] } = JSON.parse(line) as { id: number; method: string; args: unknown[] }
  const run = (async () => {
    switch (method) {
      case 'add': return stack.registry.add(primary, { path: String(args[0]) })
      case 'access': return stack.registry.setAccess(primary, { kind: 'path', path: String(args[0]) }, args[1] as 'read-only' | 'read-write')
      case 'list': return stack.registry.refresh(primary)
      case 'write': {
        const path = String(args[0]); return stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), String(args[1]))
      }
      case 'authority': return stack.registry.authority
      case 'diagnostics': return stack.registry.diagnostics
      case 'pause-write': {
        const target = await stack.ctx.fs.resolve(String(args[0]))
        const gate = new Promise<void>(resolve => { release = resolve })
        let first = true
        const restore = wrapMethod(stack.ctx.fs, 'resolve', original => async function(this: typeof stack.ctx.fs, ...args) {
          const target = await original.apply(this, args)
          if (first) {
            first = false
            process.stdout.write(JSON.stringify({ event: 'admitted', id }) + '\n')
            await gate
          }
          return target
        })
        const writing = stack.ctx.fs.writeText(target, String(args[1]))
        captured = writing.then(() => undefined)
        try { await writing; return { completed: true } }
        finally { restore() }
      }
      case 'resume': release?.(); await captured; return true
      case 'close': await stack.dispose(); return true
      case 'probe': return { rows: stack.registry.list(primary), state: stack.registry.authority, file: join(root, 'multi_root_workspace.json') }
      default: throw new Error('unsupported child request')
    }
  })()
  pending.add(run)
  void run.then(value => send(id, value), error => send(id, undefined, error)).finally(() => pending.delete(run))
})
await new Promise<void>(resolve => lines.on('close', resolve))
release?.()
await Promise.allSettled([...pending])
await stack.dispose()
