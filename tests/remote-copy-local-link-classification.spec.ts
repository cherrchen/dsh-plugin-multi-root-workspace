/**
 * A local source with more than one hard link must be classified by its link
 * count BEFORE the canonical-name comparison. macOS `F_GETPATH` may name any
 * link of a multi-linked vnode (not necessarily the one that was opened), so
 * the name comparison alone is nondeterministic there and used to surface the
 * refusal as `source-escapes-root` on some runners.
 *
 * The native handle layer is mocked so both links are real, the opened name is
 * `source.txt`, and `canonical()` reports the other link.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runRemoteCopy, type RemoteCopyDeps, type RemoteCopyRequest } from '../src/remote/transfer.ts'
import type { MultiRootRegistry } from '../src/registry.ts'

const state = vi.hoisted(() => ({ rootReal: '', otherLink: '' }))

vi.mock('../src/worktrees/native-io.ts', () => {
  const file = {
    info: () => ({ kind: 'file' }),
    canonical: () => state.otherLink,
    posixFileState: () => ({ size: 1, nlink: 2, mtimeMs: 1, ctimeMs: 1 }),
    directory: () => ({ child: () => file }),
    read: () => 0,
    close: () => {},
  }
  const directory = {
    info: () => ({ kind: 'directory' }),
    canonical: () => state.rootReal,
    posixFileState: () => ({ size: 0, nlink: 1, mtimeMs: 1, ctimeMs: 1 }),
    directory: () => ({ child: (name: string) => name === 'source.txt' ? file : directory }),
    close: () => {},
  }
  return { openMetadataRoot: () => ({ ...directory, directory: () => ({ child: () => directory }) }) }
})

let base = ''

const session = () => ({ header: { cwd: state.rootReal }, id: 's1' }) as never
const request = (): RemoteCopyRequest => ({
  session: session(),
  from: { environmentId: 'local', rootId: 'primary', relativePath: 'source.txt' },
  to: { environmentId: 'vps-a', rootId: 'import', relativePath: 'dest.txt' },
})

describe.runIf(process.platform !== 'win32')('runRemoteCopy local link classification', () => {
  beforeAll(() => {
    base = mkdtempSync(join(process.cwd(), '.dsh-smoke', 'remote-copy-links-'))
    const workspace = join(base, 'ws')
    mkdirSync(workspace)
    state.rootReal = realpathSync(workspace)
    state.otherLink = join(state.rootReal, 'hard.txt')
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('reports source-multilinked when F_GETPATH names the other link', async () => {
    const registry = {
      async withRemoteOperation(_request: unknown, body: (value: unknown) => unknown) {
        return await body({
          identity: { authorityEpoch: 'e1', effectiveMode: 'workspace-write', operationId: 'op-1' },
          endpoints: [
            { environmentId: 'local', rootId: 'primary', displayPath: 'primary', bindingDigest: null, environmentDigest: null, verifiedTarget: null, configVersion: null },
            { environmentId: 'vps-a', rootId: 'import', displayPath: '/import', bindingDigest: 'd'.repeat(64), environmentDigest: 'e'.repeat(64), verifiedTarget: { kind: 'path', value: '/import' }, configVersion: 'c' },
          ],
        })
      },
      localTransferDestination: () => ({ rootId: 'primary', root: state.rootReal, access: 'primary', deny: [] }),
    } as unknown as MultiRootRegistry
    const deps = {
      manager: {
        deployment: { environments: [{ environmentId: 'vps-a', transfer: { maxBytes: 1024, timeoutMs: 1_000 } }] },
        openSftp: async () => { throw new Error('the source open must fail before any SFTP session opens') },
        sftpGenerationOf: () => 'g1',
      },
    } as unknown as RemoteCopyDeps
    const result = await runRemoteCopy(registry, deps, request(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', code: 'source-multilinked', stage: 'source' })
  })
})
