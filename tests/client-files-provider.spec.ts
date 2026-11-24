/**
 * The provider contract's regressions: identity keys, a watch-less provider's
 * explicit initial read, stale-settlement drops across a hold boundary, the
 * row-gesture dispatch through `rowActions`, and the local adapter's
 * root-admission fence plus its file-address spelling.
 *
 * The tree side runs on the real store and face — no renderer — because the
 * contract under test is the listing pipeline, not the rows: `hold` receives
 * the provider, `treeBucketId` names its bucket, and every port only ever
 * sees a `WorkspaceResourceRef`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createFilesStore } from '../src/client/files-tree/store.ts'
import { filesFace } from '../src/client/files-tree/face.ts'
import {
  belongsTo,
  providerKey,
  rootKey,
  rowActions,
  treeBucketId,
  validRelativePath,
  type DirectoryListing,
  type FilesProviderIdentity,
  type WorkspaceFilesProvider,
  type WorkspaceResourceRef,
  type WorkspaceRootRef,
} from '../src/client/files-tree/provider.ts'
import { createLocalWorkspaceProvider } from '../src/client/files-tree/providers/local.ts'
import { createSshWorkspaceProvider } from '../src/client/files-tree/providers/ssh.ts'
import { RemoteFilesError, type RemoteFilesListing } from '../src/remote/files-contract.ts'
import type { RemoteFilesClient } from '../src/client/remote-files-client.ts'

const SESSION = 'session-1' as SessionId
const OWNER = 'pane-1' as TabId

/** An identity fixture — identical display paths still differ by these fields. */
const identity = (patch: Partial<FilesProviderIdentity> = {}): FilesProviderIdentity => ({
  sessionId: SESSION,
  root: { kind: 'additional', rootId: 'root-a' },
  incarnation: '2026-09-12T00:00:00.000Z',
  ...patch,
})

describe('provider identity keys', () => {
  it('keys a provider by session, root discriminant, and incarnation — never a path', () => {
    const base = providerKey(identity())
    // Another session browsing the same registration is another provider.
    expect(providerKey(identity({ sessionId: 'session-2' as SessionId }))).not.toBe(base)
    // Another registered root under the same session is another provider.
    expect(providerKey(identity({ root: { kind: 'additional', rootId: 'root-b' } }))).not.toBe(base)
    // A remote environment's root — even with a colliding root id — is another provider.
    expect(providerKey(identity({
      root: { kind: 'remote', environmentId: 'env-1', rootId: 'root-a' },
    }))).not.toBe(base)
    expect(providerKey(identity({
      root: { kind: 'remote', environmentId: 'env-2', rootId: 'root-a' },
    }))).not.toBe(base)
    // The primary root shares no key with any registered root.
    expect(providerKey(identity({ root: { kind: 'primary' } }))).not.toBe(base)
    // A re-granted root — a new incarnation — is a different provider, so the
    // old grant's records can never serve its tree.
    expect(providerKey(identity({ incarnation: '2026-11-24T00:00:00.000Z' }))).not.toBe(base)
  })

  it('keys a bucket by owner and provider, so two owners of one root never share a tree', () => {
    const id = identity()
    const bucket = treeBucketId(OWNER, id)
    expect(treeBucketId('pane-2' as TabId, id)).not.toBe(bucket)
    expect(treeBucketId(OWNER, identity({ root: { kind: 'additional', rootId: 'root-b' } }))).not.toBe(bucket)
    expect(treeBucketId(OWNER, identity({ incarnation: 'later' }))).not.toBe(bucket)
  })

  it('keeps the root reference the only identity inside rootKey', () => {
    expect(rootKey({ kind: 'remote', environmentId: 'env-1', rootId: 'r' }))
      .not.toBe(rootKey({ kind: 'remote', environmentId: 'env-2', rootId: 'r' }))
    expect(rootKey({ kind: 'additional', rootId: 'r' }))
      .not.toBe(rootKey({ kind: 'remote', environmentId: 'env-1', rootId: 'r' }))
  })

  it('admits only well-formed relative paths inside the provider root', () => {
    const id = identity()
    const root = id.root
    const ref = (relativePath: string, override?: WorkspaceRootRef): WorkspaceResourceRef => ({
      root: override ?? root,
      relativePath,
    })
    expect(belongsTo(id, ref(''))).toBe(true)
    expect(belongsTo(id, ref('src/inner.ts'))).toBe(true)
    expect(belongsTo(id, ref('../escape'))).toBe(false)
    expect(belongsTo(id, ref('a//b'))).toBe(false)
    expect(belongsTo(id, ref('a/./b'))).toBe(false)
    expect(belongsTo(id, ref('x', { kind: 'additional', rootId: 'root-b' }))).toBe(false)
    expect(validRelativePath('a\0b')).toBe(false)
  })
})

/** A list-only provider whose resources live under a synthetic tree root. */
function fakeProvider(options: {
  readonly entries?: { readonly name: string; readonly type: 'file' | 'directory' }[]
  readonly onList?: (resource: WorkspaceResourceRef) => void
  readonly gate?: () => Promise<void>
  readonly preview?: WorkspaceFilesProvider['preview']
} = {}): WorkspaceFilesProvider {
  const treeRoot = 'mrfw-root:/env-1/r-1'
  const root: WorkspaceRootRef = { kind: 'remote', environmentId: 'env-1', rootId: 'r-1' }
  return {
    identity: { sessionId: SESSION, root, incarnation: 'grant-1' },
    treeRoot,
    resource: (treePath) => {
      if (treePath === treeRoot) return { root, relativePath: '' }
      const prefix = `${treeRoot}/`
      return treePath.startsWith(prefix) ? { root, relativePath: treePath.slice(prefix.length) } : undefined
    },
    listDirectory: async (resource): Promise<DirectoryListing> => {
      options.onList?.(resource)
      if (options.gate !== undefined) await options.gate()
      return { ok: true, value: { entries: options.entries ?? [{ name: 'only.ts', type: 'file' }], truncated: false } }
    },
    ...(options.preview === undefined ? {} : { preview: options.preview }),
  }
}

describe('a watch-less provider through the real face and store', () => {
  it('performs its explicit initial read — exactly one list, no stream, one entry', async () => {
    const instance = createFilesStore().create('spec')
    const face = filesFace(instance.actions)
    const calls: WorkspaceResourceRef[] = []
    const provider = fakeProvider({ onList: resource => { calls.push(resource) } })
    const controller = new AbortController()
    const bucket = treeBucketId(OWNER, provider.identity)

    face.hold(bucket, provider, controller.signal)
    await vi.waitFor(() => {
      const level = instance.getSnapshot().byTab[bucket]?.levels[provider.treeRoot]
      expect(level?.kind).toBe('ready')
    })
    // No watchDirectory means no parked stream and no wait for a ready frame:
    // the root level's own listing is what opened it.
    expect(calls).toEqual([{ root: { kind: 'remote', environmentId: 'env-1', rootId: 'r-1' }, relativePath: '' }])
    const state = instance.getSnapshot().byTab[bucket]
    expect(state?.root).toBe(provider.treeRoot)
    const level = state?.levels[provider.treeRoot]
    expect(level?.kind === 'ready' ? level.level.entries : []).toEqual([{ name: 'only.ts', type: 'file' }])
  })

  it('drops an outstanding listing when the hold ended and a replacement asked the same path', async () => {
    const instance = createFilesStore().create('spec')
    const face = filesFace(instance.actions)
    let release: (() => void) | undefined
    const calls: WorkspaceResourceRef[] = []
    let call = 0
    // The stale answer carries `stale.ts`, the replacement `fresh.ts`.
    const entries = [
      [{ name: 'stale.ts', type: 'file' as const }],
      [{ name: 'fresh.ts', type: 'file' as const }],
    ]
    const root: WorkspaceRootRef = { kind: 'remote', environmentId: 'env-1', rootId: 'r-1' }
    const treeRoot = 'mrfw-root:/env-1/r-1'
    const gated: WorkspaceFilesProvider = {
      identity: { sessionId: SESSION, root, incarnation: 'grant-1' },
      treeRoot,
      resource: (treePath) => {
        if (treePath === treeRoot) return { root, relativePath: '' }
        const prefix = `${treeRoot}/`
        return treePath.startsWith(prefix) ? { root, relativePath: treePath.slice(prefix.length) } : undefined
      },
      listDirectory: async (resource): Promise<DirectoryListing> => {
        calls.push(resource)
        const which = call
        call += 1
        await new Promise<void>(resolve => { release = resolve })
        return { ok: true, value: { entries: entries[which] ?? entries[1]!, truncated: false } }
      },
    }
    const controller = new AbortController()
    const bucket = treeBucketId(OWNER, gated.identity)

    // First hold: the root listing parks inside its gate.
    face.hold(bucket, gated, controller.signal)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    // The hold ends (the body unmounted); a new hold on the same provider
    // re-opens the kept bucket and asks the same path again.
    face.release(bucket)
    face.hold(bucket, gated, controller.signal)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    // The stale answer lands first: its token is gone, so it writes nothing.
    release?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    // The replacement's answer is what the level keeps.
    await vi.waitFor(() => {
      const level = instance.getSnapshot().byTab[bucket]?.levels[gated.treeRoot]
      expect(level?.kind).toBe('ready')
      expect(level?.kind === 'ready' ? level.level.entries : []).toEqual([{ name: 'fresh.ts', type: 'file' }])
    })
    // The stale entry never overwrote it.
    expect(JSON.stringify(instance.getSnapshot().byTab[bucket])).not.toContain('stale.ts')
  })
})

describe('row gestures through rowActions', () => {
  it('hands the preview port the exact resource reference and the replace-tab route', () => {
    const open = vi.fn()
    const provider = fakeProvider({
      preview: { canOpen: () => true, open },
    })
    const rows = rowActions(provider, new AbortController().signal, 'tab-9' as TabId)
    expect(rows.canOpen(`${provider.treeRoot}/file.ts`)).toBe(true)
    rows.open?.(`${provider.treeRoot}/file.ts`)
    expect(open).toHaveBeenCalledWith(
      { root: { kind: 'remote', environmentId: 'env-1', rootId: 'r-1' }, relativePath: 'file.ts' },
      { replaceTab: 'tab-9' },
    )
  })

  it('swallows gestures whose tree key maps to no resource, and dies with the signal', () => {
    const open = vi.fn()
    const canOpen = vi.fn(() => true)
    const provider = fakeProvider({ preview: { canOpen, open } })
    const controller = new AbortController()
    const rows = rowActions(provider, controller.signal)
    rows.open?.('/foreign/root/file.ts')
    expect(open).not.toHaveBeenCalled()
    controller.abort()
    rows.open?.(`${provider.treeRoot}/file.ts`)
    expect(rows.canOpen(`${provider.treeRoot}/file.ts`)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('reports no open and no openable rows when the provider has no preview port', () => {
    const rows = rowActions(fakeProvider(), new AbortController().signal)
    expect(rows.open).toBeUndefined()
    expect(rows.canOpen('anything')).toBe(false)
    expect(rows.menu).toBeUndefined()
  })
})

describe('the local provider admission fence', () => {
  const ROOT = '/repos/payments'
  const id = identity()

  function local(overrides: {
    readonly list?: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<{ ok: true; value: { entries: never[]; truncated: boolean } }>
    readonly open?: (address: string, options?: { readonly replaceTab?: TabId }) => void
    readonly canOpen?: (address: string) => boolean
  } = {}) {
    const list = vi.fn(overrides.list ?? (async () => ({ ok: true as const, value: { entries: [], truncated: false } })))
    const open = vi.fn(overrides.open ?? (() => {}))
    const canOpen = vi.fn(overrides.canOpen ?? (() => true))
    const provider = createLocalWorkspaceProvider(
      { ...id, root: { kind: 'additional', rootId: 'root-a' } },
      ROOT,
      {
        list,
        watch: () => (async function* (): AsyncGenerator<'ready' | 'change'> { yield 'ready' })(),
        open,
        canOpen,
      },
    )
    return { provider, list, open, canOpen }
  }

  it('maps its own tree keys to resource refs and refuses foreign keys', () => {
    const { provider } = local()
    expect(provider.treeRoot).toBe(ROOT)
    expect(provider.resource(ROOT)).toEqual({ root: { kind: 'additional', rootId: 'root-a' }, relativePath: '' })
    expect(provider.resource(`${ROOT}/src/inner.ts`))
      .toEqual({ root: { kind: 'additional', rootId: 'root-a' }, relativePath: 'src/inner.ts' })
    expect(provider.resource('/repos/docs/guide')).toBeUndefined()
    expect(provider.resource(`${ROOT}/../escape`)).toBeUndefined()
  })

  it('settles a cross-root listing without a wire call', async () => {
    const { provider, list } = local()
    const foreign: WorkspaceResourceRef = { root: { kind: 'additional', rootId: 'root-b' }, relativePath: 'x' }
    const result = await provider.listDirectory(foreign, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error.code : undefined).toBe('workspace-file/outside-workspace')
    expect(list).not.toHaveBeenCalled()
  })

  it('spells the session file address the viewer and open ports consume', () => {
    const { provider, open, canOpen } = local()
    const ref = provider.resource(`${ROOT}/notes.md`)!
    expect(provider.preview?.canOpen(ref)).toBe(true)
    provider.preview?.open(ref)
    const address = 'dsh-resource://file/session/session-1//repos/payments/notes.md'
    expect(canOpen).toHaveBeenCalledWith(address)
    expect(open).toHaveBeenCalledWith(address, undefined)
    provider.preview?.open(ref, { replaceTab: 'tab-9' as TabId })
    expect(open).toHaveBeenCalledWith(address, { replaceTab: 'tab-9' })
    // The open-in-app port offers the trusted local path, never a synthetic key.
    expect(provider.openInApp?.(ref)).toBe(`${ROOT}/notes.md`)
  })
})

describe('the ssh provider cancellation fence', () => {
  const id: FilesProviderIdentity = {
    sessionId: SESSION,
    root: { kind: 'remote', environmentId: 'device', rootId: 'out' },
    incarnation: 'a'.repeat(64),
  }
  const ref: WorkspaceResourceRef = { root: id.root, relativePath: 'deep' }
  const ssh = (client: RemoteFilesClient, invalidated = vi.fn()) => ({
    provider: createSshWorkspaceProvider(id, client, code => `localized:${code}`, invalidated),
    invalidated,
  })

  it('an abort landing before a late invalidating failure never evicts the current record', async () => {
    const deferred = Promise.withResolvers<never>()
    const client: RemoteFilesClient = { list: vi.fn(() => deferred.promise), wait: vi.fn(async () => {}) }
    const { provider, invalidated } = ssh(client)
    const controller = new AbortController()
    const pending = provider.listDirectory(ref, controller.signal)
    // A->B->A with the same key: this directory's signal dies while the
    // wire call is still unanswered; the late authorization failure that
    // follows must not invalidate the record the new hold already owns.
    controller.abort()
    deferred.reject(new RemoteFilesError('binding-changed'))
    const result = await pending
    expect(invalidated).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error.code : undefined).toBe('gateway/internal')
  })

  it('an abort landing before a late success reports cancelled, not rows', async () => {
    const deferred = Promise.withResolvers<RemoteFilesListing>()
    const client: RemoteFilesClient = { list: vi.fn(() => deferred.promise), wait: vi.fn(async () => {}) }
    const { provider, invalidated } = ssh(client)
    const controller = new AbortController()
    const pending = provider.listDirectory(ref, controller.signal)
    controller.abort()
    deferred.resolve({ entries: [{ name: 'leaf.txt', type: 'file' }], truncated: false })
    const result = await pending
    expect(invalidated).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('a live request still invalidates on an authorization failure', async () => {
    const client: RemoteFilesClient = {
      list: vi.fn(async () => { throw new RemoteFilesError('root-identity-changed') }),
      wait: vi.fn(async () => {}),
    }
    const { provider, invalidated } = ssh(client)
    const result = await provider.listDirectory(ref, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(invalidated).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledWith('root-identity-changed')
  })

  it('a non-coded wire error localizes the connection group, never a raw message', async () => {
    const client: RemoteFilesClient = {
      list: vi.fn(async () => { throw new Error('socket hang up at 10.0.0.1:22') }),
      wait: vi.fn(async () => {}),
    }
    const { provider } = ssh(client)
    const result = await provider.listDirectory(ref, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error.code).toBe('gateway/internal')
      expect(result.error.message).toBe('localized:connection-failed')
      expect(result.error.message).not.toContain('10.0.0.1')
    }
  })
})
