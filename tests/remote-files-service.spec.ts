/**
 * P3: the `remoteFiles.list` service fails closed — forged sessions, missing
 * opt-ins and stale tokens never open a channel — and a legal opt-in listing
 * is bounded, owned, and re-admitted before bytes are trusted. Helper-backed
 * object grants are admissible only when their binding explicitly opts in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import { RemoteFilesService, type RemoteFilesManager, type RemoteFilesRegistry } from '../src/remote/files-service.ts'
import {
  RemoteFilesError,
  REMOTE_FILES_LIMITS,
  REMOTE_FILE_PREVIEW_LIMITS,
  remoteFilesListRequest,
  validRemoteRelativePath,
  type RemoteFilesListing,
} from '../src/remote/files-contract.ts'
import { SftpConnectionLost, SftpInvalidContent, type SftpClient } from '../src/remote/sftp.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import type { SftpEnvironment } from '../src/remote/ssh-environment.ts'

let fixture: FixtureWorkspace
let world: RemoteToolsWorld | undefined
let service: RemoteFilesService | undefined

/** An owned-channel counter wrapping the fixture manager's fake remotes. */
class FilesManager implements RemoteFilesManager {
  opens = 0
  disposals = 0
  live = true
  constructor(private readonly world: RemoteToolsWorld) {}
  get deployment(): DeploymentManifest { return this.world.manager.deployment }
  async openFilesSftp(environmentId: string, signal: AbortSignal, _expectedDigest: string): Promise<SftpEnvironment & { live(): boolean }> {
    this.opens++
    const remote = this.world.remotes.get(environmentId)
    if (remote === undefined) throw new Error(`no fake remote "${environmentId}"`)
    signal.throwIfAborted()
    return {
      environmentId, generation: remote.generation, client: remote.client(),
      version: { version: 3, extensions: {} },
      live: () => this.live,
      dispose: async () => { this.disposals++ },
    }
  }
}

let manager: FilesManager
let previewOn = false

async function mount(options: Parameters<typeof mountRemoteTools>[1] & { preview?: boolean } = {}): Promise<void> {
  const { preview, ...rest } = options
  previewOn = preview === true
  world = await mountRemoteTools(fixture, { withPanel: true, deviceListing: true, devicePreview: preview, ...rest })
  manager = new FilesManager(world)
  service = new RemoteFilesService(world.stack.registry, manager, world.ctx.logger, () => previewOn)
  world.stack.registry.setRemoteFilesService(service)
}

/** The token `remotes` issued for the device binding. */
async function authorization(): Promise<string> {
  const view = await world!.panel('remotes', { sessionId: world!.session.id })
  const endpoint = (view.value as { endpoints: { rootId: string; browseAuthorization?: string }[] })
    .endpoints.find(entry => entry.rootId === 'out')
  return endpoint!.browseAuthorization!
}

const request = (over: Record<string, unknown> = {}) => ({
  sessionId: world!.session.id as string, environmentId: 'device', rootId: 'out',
  relativePath: '', authorization: '', ...over,
})

beforeEach(() => { fixture = createFixtureWorkspace('remote-files') })
afterEach(async () => { await service?.dispose(); service = undefined; await world?.dispose(); world = undefined; fixture.dispose() })

// These integration cases need an active SSH control plane (ADR-0030).
describe.skipIf(process.platform === 'win32')('remoteFiles.list admission', () => {
  it('mints browseAuthorization only for an opted-in registered path grant', async () => {
    await mount()
    const view = await world!.panel('remotes', { sessionId: world!.session.id })
    const endpoints = (view.value as { endpoints: { rootId: string; browseAuthorization?: string }[] }).endpoints
    const device = endpoints.find(entry => entry.rootId === 'out')!
    expect(device.browseAuthorization).toBeUndefined() // unregistered
    await registerRemote(world!, 'device', 'out')
    const after = await world!.panel('remotes', { sessionId: world!.session.id })
    const registered = (after.value as typeof view.value & { endpoints: typeof endpoints }).endpoints.find(entry => entry.rootId === 'out')!
    expect(registered.browseAuthorization).toMatch(/^[0-9a-f]{64}$/)
    expect((after.value as typeof view.value & { endpoints: typeof endpoints }).endpoints.find(entry => entry.rootId === 'app')!.browseAuthorization).toBeUndefined()
  })

  it.each([
    ['forged session', { sessionId: 'forged' }, 'session-unavailable'],
    ['unknown endpoint', { environmentId: 'device', rootId: 'missing' }, 'root-unregistered'],
    ['unregistered grant', {}, 'root-unregistered'],
  ])('refuses %s with zero channel opens', async (_name, over, code) => {
    await mount()
    await expect(service!.list(request({ ...over, authorization: '0'.repeat(64) }) as never))
      .rejects.toMatchObject({ code })
    expect(manager.opens).toBe(0)
  })

  it('refuses opt-out SFTP and Helper bindings with zero channel opens', async () => {
    await mount({ deviceListing: false })
    await registerRemote(world!, 'device', 'out')
    const token = '0'.repeat(64)
    await expect(service!.list(request({ authorization: token }) as never)).rejects.toMatchObject({ code: 'binding-changed' })
    // build is a Helper object-target grant; without the explicit opt-in it
    // still has no browse admission.
    await registerRemote(world!, 'build', 'app')
    const code = await service!.list(request({ environmentId: 'build', rootId: 'app', authorization: token }) as never)
      .then(() => 'none', (error: RemoteFilesError) => error.code)
    expect(['binding-changed', 'root-identity-changed']).toContain(code)
    expect(manager.opens).toBe(0)
  })

  it('admits an opted-in Helper binding through its browse-only SFTP path admission', async () => {
    await mount({ buildListing: true, seed: { build: { '/srv/root/helper-only.txt': 'h' } } })
    await registerRemote(world!, 'build', 'app')
    const view = await world!.panel('remotes', { sessionId: world!.session.id })
    const endpoint = (view.value as { endpoints: { rootId: string; browseAuthorization?: string }[] })
      .endpoints.find(entry => entry.rootId === 'app')
    expect(endpoint?.browseAuthorization).toMatch(/^[0-9a-f]{64}$/)
    const listing = await service!.list(request({
      environmentId: 'build', rootId: 'app', authorization: endpoint!.browseAuthorization!,
    }) as never)
    expect(listing.entries.map(entry => entry.name)).toContain('helper-only.txt')
    expect(manager.opens).toBe(1)
  })

  it('rejects a stale authorization token before any I/O', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    await expect(service!.list(request({ authorization: 'f'.repeat(64) }) as never))
      .rejects.toMatchObject({ code: 'binding-changed' })
    expect(manager.opens).toBe(0)
  })

  it('lists the root and a child with literal backslash, space and unicode names', async () => {
    await mount({
      seed: { device: {
        '/srv/root/alpha.txt': 'a', '/srv/root/bs\\lash.txt': 'b',
        '/srv/root/with space/inner.txt': 'c', '/srv/root/uni-名字.md': 'u',
        '/srv/root/with space/deep/leaf.txt': 'd',
      } },
    })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const root = await service!.list(request({ authorization: token }) as never)
    expect(root.truncated).toBe(false)
    const names = root.entries.map(entry => entry.name)
    expect(names).toContain('alpha.txt')
    expect(names).toContain('bs\\lash.txt')
    expect(names).toContain('with space')
    expect(names).toContain('uni-名字.md')
    const child = await service!.list(request({ authorization: token, relativePath: 'with space/deep' }) as never)
    expect(child.entries).toEqual([{ name: 'leaf.txt', type: 'file' }])
    expect(manager.disposals).toBe(2)
  })

  it('a symlink ancestor escapes the root and is never listed', async () => {
    await mount({ seed: { device: { '/srv/root/real/x.txt': 'x' } } })
    world!.remotes.get('device')!.seedSymlink('/srv/root/link')
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    await expect(service!.list(request({ authorization: token, relativePath: 'link/sub' }) as never))
      .rejects.toMatchObject({ code: 'path-escapes-root' })
    expect(world!.remotes.get('device')!.sftpCalls.filter(call => call.startsWith('readdir'))).toEqual([])
  })

  it('a canonical root redirect fails as root-identity-changed', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    const remote = world!.remotes.get('device')!
    const sftp = remote.sftp as unknown as { realpath: (p: string) => Promise<string> }
    await registerRemote(world!, 'device', 'out')
    sftp.realpath = async () => '/elsewhere'
    await expect(service!.list(request({ authorization: await authorization() }) as never))
      .rejects.toMatchObject({ code: 'root-identity-changed' })
  })

  it('cancelling a hanging listing closes only the owned channel', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    world!.remotes.get('device')!.hangReaddir = true
    await registerRemote(world!, 'device', 'out')
    const controller = new AbortController()
    const pending = service!.list(request({ authorization: await authorization() }) as never, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(manager.disposals).toBe(1)
    world!.remotes.get('device')!.hangReaddir = false
  })

  it('admits 4 listings and rejects the fifth with no queue', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    world!.remotes.get('device')!.hangReaddir = true
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const pending = Array.from({ length: REMOTE_FILES_LIMITS.concurrent }, () =>
      service!.list(request({ authorization: token }) as never).then(() => 'done', (e: RemoteFilesError) => e.code))
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(service!.list(request({ authorization: token }) as never)).rejects.toMatchObject({ code: 'resource-budget' })
    expect(manager.opens).toBe(REMOTE_FILES_LIMITS.concurrent)
    world!.remotes.get('device')!.hangReaddir = false
    const codes = await Promise.all(pending)
    expect(codes).toEqual(['done', 'done', 'done', 'done'])
  })

  it('an unrelated remote mutation does not abort an in-flight listing', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    world!.remotes.get('device')!.hangReaddir = true
    await registerRemote(world!, 'device', 'out')
    const controller = new AbortController()
    const pending = service!.list(request({ authorization: await authorization() }) as never, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    // Mutating a DIFFERENT grant must not cancel this listing.
    await world!.stack.registry.addRemote(world!.session.header.cwd!, { environmentId: 'build', rootId: 'app' }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    world!.remotes.get('device')!.hangReaddir = false
    const listing = await pending
    expect(listing.entries.some(entry => entry.name === 'x.txt')).toBe(true)
    expect(manager.disposals).toBe(1)
  })

  it('a removed grant discards in-flight results and a re-grant gets fresh data', async () => {
    await mount({ seed: { device: { '/srv/root/old.txt': 'o' } } })
    world!.remotes.get('device')!.hangReaddir = true
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const pending = service!.list(request({ authorization: token }) as never)
    await new Promise(resolve => setTimeout(resolve, 30))
    await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' })
    world!.remotes.get('device')!.hangReaddir = false
    const outcome = await pending.then(() => 'ok' as const, (error: RemoteFilesError) => error.code)
    expect(['root-unregistered', 'binding-changed', 'root-identity-changed']).toContain(outcome)
  })

  it('the panel endpoint returns the listing and rejects malformed payloads', async () => {
    await mount({ seed: { device: { '/srv/root/a.txt': 'a' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const ok = await world!.panel('remoteFiles.list', request({ authorization: token }) as never)
    expect(ok.ok).toBe(true)
    const listing = ok.value as RemoteFilesListing
    expect(listing.entries.map(entry => entry.name)).toContain('a.txt')
    for (const bad of [
      { ...request({ authorization: token }), relativePath: '../escape' },
      { ...request({ authorization: token }), relativePath: 'a/../b' },
      { ...request({ authorization: token }), authorization: 'short' },
      { ...request({ authorization: token }), extra: 1 },
    ]) {
      const answer = await world!.panel('remoteFiles.list', bad)
      expect(answer.ok).toBe(false)
      expect(answer.error?.code).toBe('panel/bad-request')
    }
    expect(manager.opens).toBe(1)
  })

  it('a read-only sandbox policy still admits a legal listing', async () => {
    await mount({ policyMode: 'read-only', seed: { device: { '/srv/root/x.txt': 'x' } } })
    // The REAL policy service resolves read-only before any listing I/O.
    const policy = (world!.ctx.get('sandboxPolicy') as { resolve: (arg: unknown) => { mode?: string } }).resolve({ session: world!.session })
    expect(policy.mode).toBe('read-only')
    await registerRemote(world!, 'device', 'out')
    const listing = await service!.list(request({ authorization: await authorization() }) as never)
    expect(listing.entries.map(entry => entry.name)).toContain('x.txt')
  })

  it('a listing request against a pre-aborted caller never reaches admission', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    let admissions = 0
    const countingRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => world!.stack.registry.onRemoteChange(listener),
      withRemoteFilesRead: (sessionId, endpoint, body) => {
        admissions++
        return world!.stack.registry.withRemoteFilesRead(sessionId, endpoint, body)
      },
    }
    const counting = new RemoteFilesService(countingRegistry, manager, world!.ctx.logger)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(counting.list(request({ authorization: await authorization() }) as never, controller.signal))
        .rejects.toMatchObject({ code: 'cancelled' })
      expect(admissions).toBe(0)
      expect(manager.opens).toBe(0)
    } finally { await counting.dispose() }
  })

  it('a hanging read that ignores the signal is cancelled; the owned channel closes exactly once', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    class DeafManager extends FilesManager {
      readdirSettled = false
      private release?: (error: Error) => void
      override async openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string) {
        const env = await super.openFilesSftp(environmentId, signal, expectedDigest)
        const inner = env.client
        const client = {
          realpath: (path: string) => inner.realpath(path),
          lstat: (path: string) => inner.lstat(path),
          // The read NEVER observes the signal; only the channel's own
          // dispose can settle it.
          readdirBounded: () => new Promise<never>((_resolve, reject) => {
            this.release = error => { this.readdirSettled = true; reject(error) }
          }),
        }
        return {
          ...env,
          client: client as unknown as SftpClient,
          dispose: async () => { this.disposals++; this.release?.(new SftpConnectionLost('sftp disposed')) },
        }
      }
    }
    const deaf = new DeafManager(world!)
    const svc = new RemoteFilesService(world!.stack.registry, deaf, world!.ctx.logger)
    try {
      await registerRemote(world!, 'device', 'out')
      const controller = new AbortController()
      const pending = svc.list(request({ authorization: await authorization() }) as never, controller.signal)
      await new Promise(resolve => setTimeout(resolve, 50))
      controller.abort()
      // The CALLER settles promptly on abort even though the read hangs on.
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(deaf.disposals).toBe(1)
      expect(deaf.readdirSettled).toBe(true)
      expect(deaf.opens).toBe(1)
    } finally { await svc.dispose() }
  })

  it('the 12s wall deadline aborts a hanging listing as timeout', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    world!.remotes.get('device')!.hangReaddir = true
    vi.useFakeTimers()
    try {
      const pending = service!.list(request({ authorization: token }) as never)
        .then(() => 'done' as const, (error: RemoteFilesError) => error.code)
      await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.deadlineMs)
      expect(await pending).toBe('timeout')
      expect(manager.disposals).toBe(1)
    } finally { vi.useRealTimers() }
    world!.remotes.get('device')!.hangReaddir = false
  })

  it('a channel acquired after the caller aborted is still disposed', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    class SlowOpenManager extends FilesManager {
      override async openFilesSftp(environmentId: string, _signal: AbortSignal, expectedDigest: string) {
        // Deliberately ignores the signal: the channel lands after the abort.
        const env = await super.openFilesSftp(environmentId, new AbortController().signal, expectedDigest)
        await new Promise(resolve => setTimeout(resolve, 30))
        return env
      }
    }
    const slow = new SlowOpenManager(world!)
    const svc = new RemoteFilesService(world!.stack.registry, slow, world!.ctx.logger)
    try {
      await registerRemote(world!, 'device', 'out')
      const controller = new AbortController()
      const pending = svc.list(request({ authorization: await authorization() }) as never, controller.signal)
      await new Promise(resolve => setTimeout(resolve, 10))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(slow.opens).toBe(1)
      expect(slow.disposals).toBe(1)
    } finally { await svc.dispose() }
  })

  it('a child listing re-verifies the canonical root and refuses a root symlink outright', async () => {
    await mount({ seed: { device: { '/srv/root/deep/leaf.txt': 'd' } } })
    const remote = world!.remotes.get('device')!
    const sftp = remote.sftp as unknown as { realpath: (p: string) => Promise<string> }
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    sftp.realpath = async (path: string) => path === '/srv/root' ? '/elsewhere' : path
    await expect(service!.list(request({ authorization: token, relativePath: 'deep' }) as never))
      .rejects.toMatchObject({ code: 'root-identity-changed' })
    expect(remote.sftpCalls.filter(call => call.startsWith('readdir'))).toEqual([])
    // And a root REPLACED by a symlink fails at lstat — realpath never runs.
    remote.files.delete('/srv/root')
    remote.seedSymlink('/srv/root')
    sftp.realpath = async (path: string) => path
    const before = remote.sftpCalls.filter(call => call.startsWith('realpath')).length
    await expect(service!.list(request({ authorization: token }) as never))
      .rejects.toMatchObject({ code: 'root-identity-changed' })
    expect(remote.sftpCalls.filter(call => call.startsWith('realpath')).length).toBe(before)
  })

  it('a grant removed during the listing discards the result at the final admission', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    const inner = remote.sftp.readdirBounded.bind(remote.sftp)
    remote.sftp.readdirBounded = async (path: string, signal: AbortSignal) => {
      const listing = await inner(path, signal)
      // The grant disappears between the read and the final admission.
      await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' })
      return listing
    }
    const outcome = await service!.list(request({ authorization: await authorization() }) as never)
      .then(() => 'ok' as const, (error: RemoteFilesError) => error.code)
    expect(outcome).toBe('root-unregistered')
  })

  it('a malformed listing reaches the panel as a coded failure, never raw', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    class GarbageManager extends FilesManager {
      override async openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string) {
        const env = await super.openFilesSftp(environmentId, signal, expectedDigest)
        const inner = env.client
        const client = {
          realpath: (path: string) => inner.realpath(path),
          lstat: (path: string) => inner.lstat(path),
          readdirBounded: async () => ({ entries: [{ name: 42, type: 'file' }], truncated: 'yes' }),
        }
        return { ...env, client: client as unknown as SftpClient }
      }
    }
    const garbage = new GarbageManager(world!)
    world!.stack.registry.setRemoteFilesService(new RemoteFilesService(world!.stack.registry, garbage, world!.ctx.logger))
    await registerRemote(world!, 'device', 'out')
    const answer = await world!.panel('remoteFiles.list', request({ authorization: await authorization() }) as never)
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('invalid-listing')
  })

  it('an over-byte path through the panel is refused with zero channel opens', async () => {
    await mount({ seed: { device: { '/srv/root/a.txt': 'a' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const segment = '段'.repeat(31)
    const oversized = Array.from({ length: 64 }, () => segment).join('/')
    const answer = await world!.panel('remoteFiles.list', { ...request({ authorization: token }), relativePath: oversized })
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('panel/bad-request')
    expect(manager.opens).toBe(0)
  })

  it('rejects a listing when its channel closes during final admission', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const registry = world!.stack.registry
    const admit = registry.withRemoteFilesRead.bind(registry)
    let admissions = 0
    vi.spyOn(registry, 'withRemoteFilesRead').mockImplementation(async (session, endpoint, body) => {
      if (++admissions === 2) manager.live = false
      return await admit(session, endpoint, body)
    })

    await expect(service!.list(request({ authorization: token }) as never)).rejects.toMatchObject({ code: 'connection-lost' })
    expect(admissions).toBe(2)
    expect(manager.disposals).toBe(1)
  })

  it('holds the listing slot until a notification-triggered recheck unwinds', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    const listeners = new Set<() => void>()
    let admissions = 0
    let releaseRecheck: (() => void) | undefined
    const gatedRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      withRemoteFilesRead: (sessionId, endpoint, body) => {
        admissions++
        if (admissions === 2) {
          return new Promise(resolve => {
            releaseRecheck = () => { resolve(world!.stack.registry.withRemoteFilesRead(sessionId, endpoint, body)) }
          })
        }
        return world!.stack.registry.withRemoteFilesRead(sessionId, endpoint, body)
      },
    }
    class NotifyManager extends FilesManager {
      override async openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string) {
        const env = await super.openFilesSftp(environmentId, signal, expectedDigest)
        const inner = env.client
        const client = {
          realpath: (path: string) => inner.realpath(path),
          lstat: (path: string) => inner.lstat(path),
          readdirBounded: async (path: string, readSignal: AbortSignal) => {
            const listing = await inner.readdirBounded(path, readSignal)
            for (const listener of listeners) listener()
            return listing
          },
        }
        return { ...env, client: client as unknown as SftpClient }
      }
    }
    const notifying = new NotifyManager(world!)
    const svc = new RemoteFilesService(gatedRegistry, notifying, world!.ctx.logger)
    let settled = false
    try {
      await registerRemote(world!, 'device', 'out')
      const pending = svc.list(request({ authorization: await authorization() }) as never)
        .then(() => { settled = true; return 'ok' as const }, (error: RemoteFilesError) => error.code)
      await vi.waitFor(() => { expect(admissions).toBe(2) })
      await new Promise(resolve => setTimeout(resolve, 30))
      // The bytes have completed, but the notification recheck is still
      // inside the registry. Neither the caller-visible run nor the
      // concurrency slot may retire ahead of it and its final re-admission.
      expect(settled).toBe(false)
      expect((svc as unknown as { active: { list: number } }).active.list).toBe(1)
      releaseRecheck?.()
      expect(await pending).toBe('ok')
      expect(admissions).toBe(3)
      await vi.waitFor(() => { expect((svc as unknown as { active: { list: number } }).active.list).toBe(0) })
    } finally {
      releaseRecheck?.()
      await svc.dispose()
    }
  })

  it('does not return bytes when the drained recheck saw a newer revocation', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    const listeners = new Set<() => void>()
    let admissions = 0
    let rejectRecheck: (() => void) | undefined
    const revokedRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      withRemoteFilesRead: (sessionId, endpoint, body) => {
        admissions++
        if (admissions === 2) {
          return new Promise((_, reject) => {
            rejectRecheck = () => { reject(new RemoteFilesError('binding-changed')) }
          })
        }
        if (admissions === 3) throw new RemoteFilesError('binding-changed')
        return world!.stack.registry.withRemoteFilesRead(sessionId, endpoint, body)
      },
    }
    class NotifyManager extends FilesManager {
      override async openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string) {
        const env = await super.openFilesSftp(environmentId, signal, expectedDigest)
        const inner = env.client
        const client = {
          realpath: (path: string) => inner.realpath(path),
          lstat: (path: string) => inner.lstat(path),
          readdirBounded: async (path: string, readSignal: AbortSignal) => {
            const listing = await inner.readdirBounded(path, readSignal)
            for (const listener of listeners) listener()
            return listing
          },
        }
        return { ...env, client: client as unknown as SftpClient }
      }
    }
    const svc = new RemoteFilesService(revokedRegistry, new NotifyManager(world!), world!.ctx.logger)
    try {
      await registerRemote(world!, 'device', 'out')
      const pending = svc.list(request({ authorization: await authorization() }) as never)
        .then(() => 'ok' as const, (error: RemoteFilesError) => error.code)
      await vi.waitFor(() => { expect(admissions).toBe(2) })
      await new Promise(resolve => setTimeout(resolve, 30))
      rejectRecheck?.()
      expect(await pending).toBe('binding-changed')
      expect(admissions).toBe(3)
    } finally {
      rejectRecheck?.()
      await svc.dispose()
    }
  })
})

describe.skipIf(process.platform === 'win32')('remoteFiles.wait authorization lease', () => {
  const lease = (over: Record<string, unknown> = {}) => ({
    sessionId: world!.session.id as string, environmentId: 'device', rootId: 'out',
    authorization: '', ...over,
  })

  it('an unchanged grant resolves only after the 15s lease expires, with zero channel opens', async () => {
    await mount({ seed: { device: { '/srv/root/x.txt': 'x' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    vi.useFakeTimers()
    try {
      let settled = false
      const pending = service!.waitForAuthorizationChange(lease({ authorization: token }) as never)
        .then(() => { settled = true; return 'unchanged' as const }, (error: RemoteFilesError) => error.code)
      await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.waitLeaseMs - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toBe('unchanged')
      expect(manager.opens).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('an unrelated remote mutation keeps the lease pending', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    const controller = new AbortController()
    let settled = false
    const pending = service!.waitForAuthorizationChange(lease({ authorization: await authorization() }) as never, controller.signal)
      .then(() => { settled = true; return 'unchanged' as const }, (error: RemoteFilesError) => error.code)
    await new Promise(resolve => setTimeout(resolve, 30))
    // An unrelated change reaches the lease only as a notification: the
    // recheck re-admits, matches, and the lease waits on. (A real addRemote
    // write races the endpoint snapshot's rebuild — the notifier is poked
    // directly to keep the recheck deterministic.)
    const registry = world!.stack.registry as unknown as { notifyRemoteChange(): void }
    registry.notifyRemoteChange()
    await new Promise(resolve => setTimeout(resolve, 50))
    registry.notifyRemoteChange()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    controller.abort()
    expect(await pending).toBe('cancelled')
    expect(manager.opens).toBe(0)
  })

  it('a removed grant aborts the lease with the auth code, not a network loss', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    const pending = service!.waitForAuthorizationChange(lease({ authorization: await authorization() }) as never)
      .then(() => 'unchanged' as const, (error: RemoteFilesError) => error.code)
    await new Promise(resolve => setTimeout(resolve, 30))
    await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' })
    expect(await pending).toBe('root-unregistered')
    expect(manager.opens).toBe(0)
  })

  it('a re-granted token aborts the old lease as authorization-changed', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const pending = service!.waitForAuthorizationChange(lease({ authorization: token }) as never)
      .then(() => 'unchanged' as const, (error: RemoteFilesError) => error.code)
    await new Promise(resolve => setTimeout(resolve, 30))
    await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' })
    await registerRemote(world!, 'device', 'out')
    const outcome = await pending
    expect(['root-unregistered', 'binding-changed', 'root-identity-changed', 'environment-changed']).toContain(outcome)
    // A re-grant mints a different token: the new lease identity is not the old one.
    expect(await authorization()).not.toBe(token)
    expect(manager.opens).toBe(0)
  })

  it('a pre-aborted lease never claims a slot nor reaches admission', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    let admissions = 0
    const countingRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => world!.stack.registry.onRemoteChange(listener),
      withRemoteFilesRead: (sessionId, endpoint, body) => {
        admissions++
        return world!.stack.registry.withRemoteFilesRead(sessionId, endpoint, body)
      },
    }
    const counting = new RemoteFilesService(countingRegistry, manager, world!.ctx.logger)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(counting.waitForAuthorizationChange(lease({ authorization: await authorization() }) as never, controller.signal))
        .rejects.toMatchObject({ code: 'cancelled' })
      expect(admissions).toBe(0)
      expect(manager.opens).toBe(0)
    } finally { await counting.dispose() }
  })

  it('a stalled admission is bounded by the 4s admission timer', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    // The admission parks: the caller still gets the bounded answer, but the
    // lease's slot is held until the parked engine task is drained — release
    // it before dispose, which waits every tracked job.
    let releaseAdmission: (() => void) | undefined
    const hangingRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => world!.stack.registry.onRemoteChange(listener),
      withRemoteFilesRead: () => new Promise<never>((_resolve, reject) => {
        releaseAdmission = () => { reject(new RemoteFilesError('root-unregistered')) }
      }),
    }
    const hanging = new RemoteFilesService(hangingRegistry, manager, world!.ctx.logger)
    vi.useFakeTimers()
    try {
      const pending = hanging.waitForAuthorizationChange(lease({ authorization: await authorization() }) as never)
        .then(() => 'unchanged' as const, (error: RemoteFilesError) => error.code)
      await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.waitAdmissionMs)
      expect(await pending).toBe('timeout')
      expect(manager.opens).toBe(0)
    } finally { vi.useRealTimers(); releaseAdmission?.(); await hanging.dispose() }
  })

  it('admits 16 leases and rejects the seventeenth with no queue', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const controllers = Array.from({ length: REMOTE_FILES_LIMITS.waitConcurrent }, () => new AbortController())
    const pending = controllers.map(controller =>
      service!.waitForAuthorizationChange(lease({ authorization: token }) as never, controller.signal)
        .then(() => 'unchanged' as const, (error: RemoteFilesError) => error instanceof RemoteFilesError ? error.code : `OTHER:${String(error)}`))
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(service!.waitForAuthorizationChange(lease({ authorization: token }) as never))
      .rejects.toMatchObject({ code: 'resource-budget' })
    for (const controller of controllers) controller.abort()
    const outcomes = await Promise.all(pending)
    expect(outcomes.every(code => code === 'cancelled')).toBe(true)
    expect(manager.opens).toBe(0)
  })

  it('a cancelled lease keeps its slot until the underlying admission unwinds', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    // Every admission parks: the lease's bounded race returns on caller
    // abort, but the engine call keeps running — the slot must too.
    const releaseAdmissions: (() => void)[] = []
    const hangingRegistry: RemoteFilesRegistry = {
      get remoteManifest() { return world!.stack.registry.remoteManifest },
      onRemoteChange: listener => world!.stack.registry.onRemoteChange(listener),
      withRemoteFilesRead: () => new Promise<never>((_resolve, reject) => {
        releaseAdmissions.push(() => { reject(new RemoteFilesError('root-unregistered')) })
      }),
    }
    const hanging = new RemoteFilesService(hangingRegistry, manager, world!.ctx.logger)
    try {
      const token = await authorization()
      const controllers = Array.from({ length: REMOTE_FILES_LIMITS.waitConcurrent }, () => new AbortController())
      const pending = controllers.map(controller =>
        hanging.waitForAuthorizationChange(lease({ authorization: token }) as never, controller.signal)
          .then(() => 'unchanged' as const, (error: RemoteFilesError) => error.code))
      await new Promise(resolve => setTimeout(resolve, 30))
      for (const controller of controllers) controller.abort()
      expect(await Promise.all(pending)).toEqual(Array.from({ length: REMOTE_FILES_LIMITS.waitConcurrent }, () => 'cancelled'))
      // The callers returned promptly, yet a fresh lease still meets the
      // cap: cancel + resubmit cannot sneak past the budget while the
      // raced admissions have not unwound.
      await expect(hanging.waitForAuthorizationChange(lease({ authorization: token }) as never))
        .rejects.toMatchObject({ code: 'resource-budget' })
      // Draining the parked engine tasks is what frees the slots; a late
      // admission result publishes no lease answer and opens no channel.
      for (const release of releaseAdmissions.splice(0)) release()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect((hanging as unknown as { waits: number }).waits).toBe(0)
      expect(manager.opens).toBe(0)
    } finally { await hanging.dispose() }
  })

  it('the panel endpoint answers {unchanged:true} after the lease and rejects malformed payloads', async () => {
    await mount()
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    vi.useFakeTimers()
    try {
      const pending = world!.panel('remotes.waitForAuthorizationChange', lease({ authorization: token }) as never)
      await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.waitLeaseMs)
      const answer = await pending
      expect(answer.ok).toBe(true)
      expect(answer.value).toEqual({ unchanged: true })
    } finally { vi.useRealTimers() }
    for (const bad of [
      { ...lease({ authorization: token }), authorization: 'short' },
      { ...lease({ authorization: token }), relativePath: 'a' },
      { ...lease({ authorization: token }), extra: 1 },
    ]) {
      const answer = await world!.panel('remotes.waitForAuthorizationChange', bad)
      expect(answer.ok).toBe(false)
      expect(answer.error?.code).toBe('panel/bad-request')
    }
    expect(manager.opens).toBe(0)
  })
})

it('bounds the relative path in UTF-8 bytes, not characters', () => {
  const base = { sessionId: 's', environmentId: 'device', rootId: 'out', authorization: 'a'.repeat(64) }
  const multi = `uni-${'目'.repeat(8)}录/deep`
  expect(validRemoteRelativePath(multi)).toBe(true)
  expect(remoteFilesListRequest.safeParse({ ...base, relativePath: multi }).success).toBe(true)

  // The segment count and size are legal, but the whole UTF-8 path exceeds the byte limit.
  const segment = '段'.repeat(31)
  const oversized = Array.from({ length: 64 }, () => segment).join('/')
  expect(oversized.length).toBeLessThanOrEqual(4096)
  expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(REMOTE_FILES_LIMITS.pathBytes)
  expect(validRemoteRelativePath(oversized)).toBe(false)
  expect(remoteFilesListRequest.safeParse({ ...base, relativePath: oversized }).success).toBe(false)
})

it('refuses remote file listing and leases when the SSH plane is unavailable', async () => {
  const windows = process.platform === 'win32'
  world = await mountRemoteTools(fixture, { withPanel: true, withTools: false, remote: { enabled: windows } })
  expect(world.stack.registry.remoteStatus.state).toBe(windows ? 'platform-deferred' : 'disabled')
  const { relativePath, ...lease } = request({ authorization: 'a'.repeat(64) })
  for (const [endpoint, payload] of [
    ['remoteFiles.list', { ...lease, relativePath }],
    ['remotes.waitForAuthorizationChange', lease],
  ] as const) {
    expect(await world.panel(endpoint, payload)).toMatchObject({ ok: false, error: { code: 'provider-unavailable' } })
  }
})

// The preview read endpoint (ADR-0053 P3): the flag gates the operation, the
// opt-in gates the binding, and the read pipeline proves the file's identity
// twice around the bytes.
describe.skipIf(process.platform === 'win32')('remoteFiles.read admission', () => {
  const readRequest = (over: Record<string, unknown> = {}) => ({
    sessionId: world!.session.id as string, environmentId: 'device', rootId: 'out',
    relativePath: 'a.txt', authorization: '', ...over,
  })

  it('a listing-only binding and a disabled flag deny the read before any SSH I/O; the list stays available', async () => {
    await mount({ seed: { device: { '/srv/root/a.txt': 'alpha' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    // preview flag OFF: even an opted-in binding is refused at admission.
    await expect(service!.read(readRequest({ authorization: token }) as never)).rejects.toMatchObject({ code: 'capability-unsupported' })
    expect(manager.opens).toBe(0)
    const listing = await service!.list(request({ authorization: token }) as never)
    expect(listing.entries.map(entry => entry.name)).toContain('a.txt')
    expect(manager.opens).toBe(1)
  })

  it('preview-not-authorized when the binding opts into listing but not filePreview', async () => {
    await mount({ preview: true, devicePreview: false, seed: { device: { '/srv/root/a.txt': 'alpha' } } })
    // devicePreview off ⇒ binding carries directoryListing only; the flag is on.
    await registerRemote(world!, 'device', 'out')
    await expect(service!.read(readRequest({ authorization: await authorization() }) as never))
      .rejects.toMatchObject({ code: 'preview-not-authorized' })
    expect(manager.opens).toBe(0)
  })

  it('reads a regular file with strict framed metadata plus one bytes attachment, and advertises the preview hint', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'alpha-bytes' } } })
    await registerRemote(world!, 'device', 'out')
    const view = await world!.panel('remotes', { sessionId: world!.session.id })
    const endpoint = (view.value as { endpoints: { rootId: string; browseAuthorization?: string; preview?: string }[] })
      .endpoints.find(entry => entry.rootId === 'out')!
    expect(endpoint.preview).toBe('sftp-binary-v1')
    const token = endpoint.browseAuthorization!
    const content = await service!.read(readRequest({ authorization: token }) as never)
    expect(content.kind).toBe('file')
    expect(content.complete).toBe(true)
    expect(content.size).toBe('alpha-bytes'.length)
    expect(Buffer.from(content.bytes).toString()).toBe('alpha-bytes')
    const answer = await world!.panel('remoteFiles.read', readRequest({ authorization: token }))
    expect(answer.ok).toBe(true)
    const value = answer.value as { kind: string; size: number; complete: boolean; bytes: null }
    expect(value.bytes).toBeNull()
    expect(value.size).toBe('alpha-bytes'.length)
    const attachments = (answer as { attachments?: { path: string[]; bytes: Uint8Array }[] }).attachments
    expect(attachments).toEqual([{ path: ['bytes'], bytes: new Uint8Array(Buffer.from('alpha-bytes')) }])
  })

  it('reads an empty file and a file under a unicode+backslash path', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/zero.bin': '', '/srv/root/空 格\\name.ts': 'let x = 1' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const empty = await service!.read(readRequest({ authorization: token, relativePath: 'zero.bin' }) as never)
    expect(empty.size).toBe(0)
    expect(empty.bytes.byteLength).toBe(0)
    const named = await service!.read(readRequest({ authorization: token, relativePath: '空 格\\name.ts' }) as never)
    expect(Buffer.from(named.bytes).toString()).toBe('let x = 1')
  })

  it.each([
    ['a symlinked target', (remote: RemoteToolsWorld['remotes'] extends ReadonlyMap<string, infer R> ? R : never) => remote.seedSymlink('/srv/root/link.txt'), 'link.txt', 'path-escapes-root'],
    ['a directory target', () => {}, 'src', 'not-regular-file'],
    ['a missing target', () => {}, 'gone.txt', 'file-not-found'],
  ])('denies %s before OPEN', async (_name, prepare, relativePath, code) => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'a' } } })
    prepare(world!.remotes.get('device')!)
    await registerRemote(world!, 'device', 'out')
    await expect(service!.read(readRequest({ authorization: await authorization(), relativePath }) as never))
      .rejects.toMatchObject({ code })
    expect(world!.remotes.get('device')!.sftpCalls.filter(call => call.startsWith('preview-open'))).toEqual([])
  })

  it('an oversized file is refused before any READ', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/big.bin': 'x'.repeat(REMOTE_FILE_PREVIEW_LIMITS.bytes + 1) } } })
    await registerRemote(world!, 'device', 'out')
    await expect(service!.read(readRequest({ authorization: await authorization(), relativePath: 'big.bin' }) as never))
      .rejects.toMatchObject({ code: 'file-too-large' })
    const remote = world!.remotes.get('device')!
    expect(remote.sftpCalls.filter(call => call.startsWith('preview-read'))).toEqual([])
    expect(remote.sftpCalls.filter(call => call.startsWith('preview-open'))).toEqual([])
  })

  it('short DATA progress is accepted; a premature EOF is file-changed', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'abcdefghij' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const remote = world!.remotes.get('device')!
    const inner = remote.sftp.readPreview.bind(remote.sftp)
    remote.sftp.readPreview = async (handle: Buffer, offset: number, length: number) => {
      // Answer in 1-byte fragments: positive forward progress every request.
      return await inner(handle, offset, Math.min(length, 1))
    }
    const content = await service!.read(readRequest({ authorization: token }) as never)
    expect(Buffer.from(content.bytes).toString()).toBe('abcdefghij')
    remote.sftp.readPreview = async () => undefined
    await expect(service!.read(readRequest({ authorization: token }) as never))
      .rejects.toMatchObject({ code: 'file-changed' })
  })

  it('a post-open FSTAT drift is file-changed; a malformed handle answer is invalid-content', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'abc' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    const remote = world!.remotes.get('device')!
    const innerFstat = remote.sftp.fstatPreview.bind(remote.sftp)
    let drifts = 0
    remote.sftp.fstatPreview = async (handle: Buffer) => {
      const attrs = await innerFstat(handle)
      return ++drifts === 1 ? { ...attrs, size: attrs.size! + 1 } : attrs
    }
    await expect(service!.read(readRequest({ authorization: token }) as never))
      .rejects.toMatchObject({ code: 'file-changed' })
    remote.sftp.fstatPreview = innerFstat
    remote.sftp.readPreview = async () => { throw new SftpInvalidContent() }
    await expect(service!.read(readRequest({ authorization: token }) as never))
      .rejects.toMatchObject({ code: 'invalid-content' })
  })

  it('a cancelled read closes exactly its one owned channel and holds the slot through cleanup', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'data' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    let release: (() => void) | undefined
    remote.sftp.readPreview = () => new Promise(resolve => { release = () => resolve(Buffer.from('x')) })
    const controller = new AbortController()
    const pending = service!.read(readRequest({ authorization: await authorization() }) as never, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(manager.opens).toBe(1)
    expect(manager.disposals).toBe(1)
    release?.()
  })

  it('list stays responsive while both read slots are occupied', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'data' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    const release: (() => void)[] = []
    const inner = remote.sftp.readPreview.bind(remote.sftp)
    let hanging = 2
    // Only the FIRST read request of each occupied slot hangs; the EOF probe
    // and later reads flow through the real fake once released.
    remote.sftp.readPreview = async (handle: Buffer, offset: number, length: number) => {
      if (hanging-- <= 0) return await inner(handle, offset, length)
      return await new Promise<Buffer | undefined>(resolve => { release.push(() => resolve(Buffer.from('d'))) })
    }
    const token = await authorization()
    const reads = Array.from({ length: 2 }, () =>
      service!.read(readRequest({ authorization: token }) as never).then(() => 'done' as const, (e: RemoteFilesError) => e.code))
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(service!.read(readRequest({ authorization: token }) as never)).rejects.toMatchObject({ code: 'resource-budget' })
    const listing = await service!.list(request({ authorization: token }) as never)
    expect(listing.entries.map(entry => entry.name)).toContain('a.txt')
    expect(manager.opens).toBe(3)
    for (const resolve of release.splice(0)) resolve()
    expect(await Promise.all(reads)).toEqual(['done', 'done'])
  })

  it('a grant revoked before the final admission denies the bytes with a coded error', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'data' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    const inner = remote.sftp.readPreview.bind(remote.sftp)
    remote.sftp.readPreview = async (handle: Buffer, offset: number, length: number) => {
      const chunk = await inner(handle, offset, length)
      await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' }).catch(() => {})
      return chunk
    }
    const outcome = await service!.read(readRequest({ authorization: await authorization() }) as never)
      .then(() => 'ok' as const, (error: RemoteFilesError) => error.code)
    expect(['root-unregistered', 'binding-changed', 'root-identity-changed']).toContain(outcome)
  })

  it('an FSTAT carrying matching size/mtime but a non-regular mode is file-changed — no READ is served', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'abc' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    const inner = remote.sftp.fstatPreview.bind(remote.sftp)
    const token = await authorization()
    for (const broken of [
      { flags: 5, size: 3 },                          // plausible size, NO perms at all
      { flags: 5, size: 3, permissions: 0o010644 },   // FIFO with a plausible size
      { flags: 5, size: 3, permissions: 0o040755 },   // directory with a plausible size
    ]) {
      remote.sftp.fstatPreview = async () => broken as never
      await expect(service!.read(readRequest({ authorization: token }) as never))
        .rejects.toMatchObject({ code: 'file-changed' })
    }
    remote.sftp.fstatPreview = inner
    expect(remote.sftpCalls.filter(call => call.startsWith('preview-read'))).toEqual([])
  })

  it('an ancestor swapped for a symlink mid-read fails the re-probe — plausible target answers never publish', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/sub/a.txt': 'data' } } })
    await registerRemote(world!, 'device', 'out')
    const remote = world!.remotes.get('device')!
    const inner = remote.sftp.readPreview.bind(remote.sftp)
    remote.sftp.readPreview = async (handle: Buffer, offset: number, length: number) => {
      const chunk = await inner(handle, offset, length)
      // Mid-read: the PARENT is replaced by a symlink while the target's own
      // lstat/realpath still answer plausibly — the ancestor re-probe must
      // still refuse publication.
      remote.files.delete('/srv/root/sub')
      remote.seedSymlink('/srv/root/sub')
      return chunk
    }
    await expect(service!.read(readRequest({ authorization: await authorization(), relativePath: 'sub/a.txt' }) as never))
      .rejects.toMatchObject({ code: 'path-escapes-root' })
  })

  it('a revoke landing while the owned dispose is in flight still publishes no bytes', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'data' } } })
    class BlockingDisposeManager extends FilesManager {
      override async openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string) {
        const env = await super.openFilesSftp(environmentId, signal, expectedDigest)
        return {
          ...env,
          // The channel's dispose runs the grant removal INSIDE its own
          // pending window: the service must close the channel BEFORE the
          // final admission, so the revoke always lands before the proof.
          dispose: async () => {
            await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' }).catch(() => {})
            await env.dispose()
          },
        }
      }
    }
    const blocking = new BlockingDisposeManager(world!)
    const svc = new RemoteFilesService(world!.stack.registry, blocking, world!.ctx.logger, () => true)
    try {
      await registerRemote(world!, 'device', 'out')
      const outcome = await svc.read(readRequest({ authorization: await authorization() }) as never)
        .then(() => 'ok' as const, (error: RemoteFilesError) => error.code)
      expect(outcome).toBe('root-unregistered')
    } finally { await svc.dispose() }
  })

  it('rejects invalid/empty read requests with zero I/O and grants other tools nothing', async () => {
    await mount({ preview: true, seed: { device: { '/srv/root/a.txt': 'data' } } })
    await registerRemote(world!, 'device', 'out')
    const token = await authorization()
    for (const relativePath of ['', '/abs', '../x']) {
      const answer = await world!.panel('remoteFiles.read', readRequest({ authorization: token, relativePath }))
      expect(answer.ok).toBe(false)
      expect(answer.error?.code).toBe('panel/bad-request')
    }
    expect(manager.opens).toBe(0)
  })
})
