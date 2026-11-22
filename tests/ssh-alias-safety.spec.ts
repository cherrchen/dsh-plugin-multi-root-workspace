/**
 * ssh-config alias environments connect through the user's own `~/.ssh/config`
 * — whose options we do not control — so the argv forces the same three
 * safety options the SFTP client uses (StrictHostKeyChecking=yes,
 * ForwardAgent=no, UpdateHostKeys=no). Managed aliases get them from the
 * generated ssh_config (`-F`), not duplicated on the command line.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sshArgs, testConnection } from '../src/remote/personal/operations.ts'
import type { ExecFile } from '../src/remote/personal/credentials.ts'
import type { PersonalEnvironment } from '../src/remote/personal/config.ts'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'alias-safety-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })


const ALIAS_ENV: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'ssh-config', alias: 'devbox' },
  hostKey: 'SHA256:' + 'A'.repeat(43),
  helper: null,
}
const MANAGED_ENV: PersonalEnvironment = { ...ALIAS_ENV, credential: { kind: 'managed', credentialId: 'aabbccddeeff' } }

describe('sshArgs safety options', () => {
  it('forces the three safety options for ssh-config aliases, before the alias', () => {
    const args = sshArgs(ALIAS_ENV, tmp())
    for (const flag of ['StrictHostKeyChecking=yes', 'ForwardAgent=no', 'UpdateHostKeys=no']) {
      const index = args.indexOf(flag)
      expect(index).toBeGreaterThan(-1)
      expect(args[index - 1]).toBe('-o')
      expect(index).toBeLessThan(args.indexOf('devbox'))
    }
    expect(args.at(-1)).toBe('devbox')
  })

  it('does not duplicate them for managed environments — the -F config already pins them', () => {
    const credentialRoot = tmp()
    const args = sshArgs(MANAGED_ENV, credentialRoot)
    expect(args[0]).toBe('-F')
    expect(args[1]).toBe(join(credentialRoot, 'ssh_config'))
    expect(args.includes('StrictHostKeyChecking=yes')).toBe(false)
    expect(args.at(-1)).toBe('dsh-dev-box')
  })

  it('testConnection argv carries them for an alias', async () => {
    let argv: readonly string[] = []
    const exec: ExecFile = async (_file, args) => { argv = args; return { stdout: 'Linux\n/usr/bin/node\nv24.0.0\n', stderr: '' } }
    await testConnection(exec, ALIAS_ENV, tmp())
    for (const flag of ['StrictHostKeyChecking=yes', 'ForwardAgent=no', 'UpdateHostKeys=no']) {
      expect(argv).toContain(flag)
    }
    expect(argv).toContain('BatchMode=yes')
  })
})
