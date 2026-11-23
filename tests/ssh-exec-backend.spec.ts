import { execFile } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lazySshExecBackend, sshExecBackend } from '../src/remote/ssh-exec-backend.ts'
import type { OutputChunkMeta } from '../src/remote/exec.ts'
import { fakeManifest } from './support/fake-remote.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace | undefined
afterEach(() => { fixture?.dispose(); fixture = undefined })

describe.skipIf(process.platform === 'win32')('helper-only execution cwd verification', () => {
  it('uses a read-only helper probe without transfer and refuses redirected or escaped directories', async () => {
    fixture = createFixtureWorkspace('exec-only')
    const root = fixture.workspace
    mkdirSync(join(root, 'nested'))
    symlinkSync(join(root, 'nested'), join(root, 'alias'))
    const environment = fakeManifest({ primary: root }).environments[0]!
    delete environment.transfer
    const policies: unknown[] = []
    const manager = {
      openSftp: vi.fn(async () => { throw new Error('transfer disabled') }),
      generationOf: () => 'g', markStale() {},
      open: async () => ({
        generation: 'g', hello: { executable: process.execPath, platform: process.platform },
        sandbox: { confine: async (argv: readonly string[], policy: unknown) => { policies.push(policy); return { argv, enforcement: 'full' } } },
        subprocess: { spawn: (spec: unknown) => {
          const { argv, cwd } = spec as { argv: string[]; cwd: string }
          let output = ''
          const child = execFile(argv[0]!, argv.slice(1), { cwd }, (_error, stdout) => { output = stdout })
          const done = new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })))
          return { done, collected: { stdout: { readFrom: () => ({ text: output }) } }, terminate: () => { child.kill() }, waitForExit: async () => { await done; return true } }
        } },
      }),
    }
    const backend = lazySshExecBackend(environment, manager as never)!
    const signal = new AbortController().signal
    await expect(backend.verifyCwd!(root, root, signal, null)).resolves.toBeUndefined()
    await expect(backend.verifyCwd!(join(root, 'nested'), root, signal, null)).resolves.toBeUndefined()
    await expect(backend.verifyCwd!(join(root, 'alias'), root, signal, null)).rejects.toMatchObject({ code: 'target-escapes-root' })
    await expect(backend.verifyCwd!(fixture.base, root, signal, null)).rejects.toMatchObject({ code: 'target-escapes-root' })
    expect(manager.openSftp).not.toHaveBeenCalled()
    expect(policies.length).toBeGreaterThan(0)
    expect(policies.every(policy => (policy as { mode: string }).mode === 'read-only')).toBe(true)
  })
})

describe('collected output coordinates passed to the sink', () => {
  function runAdapter(collected: { text: string; nextOffset?: number; lossy?: boolean }) {
    fixture = createFixtureWorkspace('exec-coordinates')
    const environment = fakeManifest({ primary: fixture.workspace }).environments[0]!
    const manager = { markStale() {}, generationOf: () => 'g' }
    const env = {
      generation: 'g',
      hello: { executable: process.execPath, platform: process.platform },
      sandbox: { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' as const }) },
      subprocess: {
        spawn: () => ({
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: { readFrom: () => collected } },
          terminate: () => {},
          waitForExit: async () => true,
        }),
      },
    }
    const backend = sshExecBackend(environment, env as never, manager as never)!
    const chunks: { chunk: Uint8Array; meta?: OutputChunkMeta }[] = []
    const handle = backend.spawn(['/bin/sh', '-c', 'x'], { cwd: '/srv/root', env: {}, generation: 'g' }, {
      stdout: (chunk, meta) => chunks.push({ chunk, meta }),
      stderr: () => {},
    })
    return { chunks, exited: handle.exited }
  }

  it('passes whole-stream coordinates through for a byte-faithful window', async () => {
    const adapter = runAdapter({ text: 'hello', nextOffset: 5, lossy: false })
    await adapter.exited
    expect(adapter.chunks).toHaveLength(1)
    expect(adapter.chunks[0]!.meta).toEqual({ lossy: false, totalBytes: 5, offset: 0 })
    expect(Buffer.from(adapter.chunks[0]!.chunk).toString()).toBe('hello')
  })

  it('derives the offset of a lossy tail that starts on a character boundary', async () => {
    const adapter = runAdapter({ text: 'def', nextOffset: 6, lossy: true })
    await adapter.exited
    expect(adapter.chunks[0]!.meta).toEqual({ lossy: true, totalBytes: 6, offset: 3 })
  })

  it.each(['\uFFFDdef', 'def\uFFFD'])('preserves a lossy window with %s and marks its byte mapping approximate', async text => {
    const adapter = runAdapter({ text, nextOffset: 20, lossy: true })
    await adapter.exited
    expect(adapter.chunks[0]!.meta).toMatchObject({ lossy: true, totalBytes: 20, approximate: true })
    expect((adapter.chunks[0]!.meta as { offset?: number }).offset).toBeUndefined()
    expect(Buffer.from(adapter.chunks[0]!.chunk).toString()).toBe(text)
  })

  it('omits coordinates for an older collector that returns text only', async () => {
    const adapter = runAdapter({ text: 'legacy' })
    await adapter.exited
    expect(adapter.chunks[0]!.meta).toEqual({ lossy: false })
  })
})
