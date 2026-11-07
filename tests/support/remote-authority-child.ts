/** NDJSON remote Host: production storage, Registry, remote plane, sessions. */
import { createInterface } from 'node:readline'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { mountRegistryStack } from './registry-stack.ts'
const { root, primary, manifest, mode } = JSON.parse(process.argv[2]!) as { root: string; primary: string; manifest?: string; mode?: string }
const stack = await mountRegistryStack(root, {
  sharedStorageRoot: root,
  remoteEnvironments: manifest === undefined ? undefined : { enabled: true, manifestPath: manifest },
}, { beforeGate: async ctx => {
  await ctx.plugin(Projections)
  await ctx.plugin(Sessions)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: primary })
} })
stack.registry.setRemoteEndpointVerifier({ verify: async (_e, b) => ({ platform: 'linux' as const, target: { kind: 'path' as const, value: b.path } }) })
await stack.registry.refresh(primary)
const session = stack.ctx.sessions.create(SessionId('remote-e2e'), { meta: { cwd: primary } })
if (mode !== undefined) session.append('sandbox/mode', { mode })
process.stdout.write(JSON.stringify({ ready: true, authority: stack.registry.authority.kind, unavailable: stack.registry.unavailable, remote: stack.registry.remoteStatus }) + '\n')
const send = (id: number, value: unknown, error?: unknown) => process.stdout.write(JSON.stringify({ id, value, ...(error === undefined ? {} : { error: String(error), code: (error as { code?: unknown })?.code }) }) + '\n')
const pending = new Set<Promise<unknown>>()
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, args = [] } = JSON.parse(line) as { id: number; method: string; args: unknown[] }
  const run = (async () => {
    switch (method) {
      case 'add': return stack.registry.add(primary, { path: String(args[0]) })
      case 'list': return stack.registry.refresh(primary)
      case 'authority': return stack.registry.authority
      case 'diagnostics': return stack.registry.diagnostics
      case 'remote-status': return stack.registry.remoteStatus
      case 'remote-list': return stack.registry.remoteList(primary)
      case 'remote-add': return stack.registry.addRemote(primary, args[0] as never)
      case 'remote-remove': return stack.registry.removeRemote(primary, args[0] as never)
      case 'remote-op': return stack.registry.withRemoteOperation({
        session, toolName: 'remote_probe', purpose: args[0] as never, endpoints: args[1] as never,
      }, operation => ({ identity: operation.identity, endpoints: operation.endpoints }))
      case 'probe': return { rows: stack.registry.list(primary), state: stack.registry.authority, remote: stack.registry.remoteStatus }
      case 'close': await stack.dispose(); return true
      default: throw new Error('unsupported child request')
    }
  })()
  pending.add(run)
  void run.then(value => send(id, value), error => send(id, undefined, error)).finally(() => pending.delete(run))
})
await new Promise<void>(resolve => process.stdin.on('close', resolve))
await Promise.allSettled([...pending])
await stack.dispose()
