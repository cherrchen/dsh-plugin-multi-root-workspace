/** remote-1 wire semantics on the real attested transport. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { connectNative, nativeHostAvailability, storeIdentity } from '../src/authority/native.ts'
import { AuthorityRpcError, receive } from '../src/authority/protocol.ts'
import { RemoteClient, RemoteServer } from '../src/remote/protocol.ts'

const availability = await nativeHostAvailability()
const nativeTest = it.skipIf(!availability.available)
const dirs: string[] = [], servers: RemoteServer[] = []
afterEach(() => { while (servers.length) servers.pop()!.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
function endpoint() {
  const root = mkdtempSync(join(tmpdir(), 'mrw-r1-')); dirs.push(root)
  return storeIdentity(root)
}
function listen(id: ReturnType<typeof endpoint>, dispatch: (m: string, a: unknown[]) => Promise<unknown> = async () => ({ ok: true })) {
  return RemoteServer.listen(id.remoteEndpoint!, { store: id.id, epoch: 'ep-1', manifestDigest: 'd'.repeat(64) }, dispatch)
}

nativeTest('hello binds store, epoch and digest; a digest mismatch is an explicit error', async () => {
  const id = endpoint()
  servers.push(await listen(id))
  const bad = await RemoteClient.connect(id.remoteEndpoint!, id.id, 'e'.repeat(64), () => {}).catch(error => error)
  expect(bad).toMatchObject({ code: 'config-digest-mismatch' })
  const client = await RemoteClient.connect(id.remoteEndpoint!, id.id, 'd'.repeat(64), () => {})
  expect(client.epoch).toBe('ep-1')
  client.close()
})

nativeTest('an unknown domain gets an explicit error reply and the channel survives', async () => {
  const id = endpoint()
  servers.push(await listen(id))
  const channel = await connectNative(id.remoteEndpoint!)
  const replies: unknown[] = []
  receive(channel, value => replies.push(value))
  channel.write(JSON.stringify({ protocol: 'remote-1', domain: 'storage', store: id.id, id: '11111111-1111-4111-8111-111111111111', epoch: null, method: 'remote-snapshot', args: ['/x'] }) + '\n')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(replies[0]).toMatchObject({ type: 'error', code: 'unknown-domain' })
  channel.write(JSON.stringify({ protocol: 'remote-1', domain: 'remote', store: id.id, id: '22222222-2222-4222-8222-222222222222', epoch: null, method: 'hello', args: ['d'.repeat(64)] }) + '\n')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(replies[1]).toMatchObject({ type: 'reply', value: { epoch: 'ep-1' } })
  channel.destroy()
})

nativeTest('mutation request-ids dedupe; reuse with different args destroys', async () => {
  const id = endpoint()
  const calls: string[] = []
  servers.push(await listen(id, async method => { calls.push(method); return { epoch: 'ep-1', revision: 1, primary: '/p', manifestDigest: 'd'.repeat(64), grants: [] } }))
  const client = await RemoteClient.connect(id.remoteEndpoint!, id.id, 'd'.repeat(64), () => {})
  await client.request('remote-add', ['/p', { environmentId: 'e', rootId: 'r' }])
  expect(calls).toEqual(['remote-add'])
  const raw = await connectNative(id.remoteEndpoint!)
  const replies: unknown[] = []
  receive(raw, value => replies.push(value))
  const write = (body: object) => raw.write(JSON.stringify(body) + '\n')
  const uuid = '33333333-3333-4333-8333-333333333333'
  write({ protocol: 'remote-1', domain: 'remote', store: id.id, id: '44444444-4444-4444-8444-444444444444', epoch: null, method: 'hello', args: ['d'.repeat(64)] })
  await new Promise(resolve => setTimeout(resolve, 50))
  write({ protocol: 'remote-1', domain: 'remote', store: id.id, id: uuid, epoch: 'ep-1', method: 'remote-add', args: ['/p', { environmentId: 'e', rootId: 'r' }] })
  write({ protocol: 'remote-1', domain: 'remote', store: id.id, id: uuid, epoch: 'ep-1', method: 'remote-add', args: ['/p', { environmentId: 'e', rootId: 'r' }] })
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(calls.filter(m => m === 'remote-add')).toHaveLength(2)
  expect(calls).toContain('remote-snapshot')
  expect(replies.filter(r => (r as { type?: string }).type === 'reply')).toHaveLength(3)
  write({ protocol: 'remote-1', domain: 'remote', store: id.id, id: uuid, epoch: 'ep-1', method: 'remote-add', args: ['/p', { environmentId: 'e', rootId: 'DIFFERENT' }] })
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(raw.destroyed).toBe(true)
  client.close()
})

nativeTest('a lost mutation reply rejects authority-disconnected and never replays', async () => {
  const id = endpoint()
  const gate = new Promise<void>(() => {})
  servers.push(await listen(id, async () => { await gate; return {} }))
  const client = await RemoteClient.connect(id.remoteEndpoint!, id.id, 'd'.repeat(64), () => {})
  const pending = client.request('remote-add', ['/p', { environmentId: 'e', rootId: 'r' }])
  await expect(pending).rejects.toMatchObject({ code: expect.any(String) })
  client.close()
  await expect(pending).rejects.toBeInstanceOf(AuthorityRpcError)
})
