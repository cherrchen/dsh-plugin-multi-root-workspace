import { execFile } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lazySshExecBackend } from '../src/remote/ssh-exec-backend.ts'
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
    await expect(backend.verifyCwd!(join(root, 'alias'), root, signal, null)).rejects.toMatchObject({ code: 'endpoint-redirected' })
    await expect(backend.verifyCwd!(fixture.base, root, signal, null)).rejects.toMatchObject({ code: 'target-escapes-root' })
    expect(manager.openSftp).not.toHaveBeenCalled()
    expect(policies.length).toBeGreaterThan(0)
    expect(policies.every(policy => (policy as { mode: string }).mode === 'read-only')).toBe(true)
  })
})
