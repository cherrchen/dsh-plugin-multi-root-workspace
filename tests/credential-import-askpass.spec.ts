/**
 * Encrypted-key import feeds the old passphrase through SSH_ASKPASS (a 0700
 * temp dir, a 0600 secret file, SSH_ASKPASS_REQUIRE=force) — never through
 * ssh-keygen argv, where `ps` could expose it. Verified against the real
 * `ssh-keygen` on this machine.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore, CredentialError, type ExecFile } from '../src/remote/personal/credentials.ts'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'askpass-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

const haveSshKeygen = (() => {
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' }) } catch (error) {
    return (error as { status?: number }).status !== undefined || String(error).includes('usage')
  }
  return true
})()

describe.skipIf(process.platform === 'win32' || !haveSshKeygen)('CredentialStore.importKey askpass flow', () => {
  it('the passphrase never enters argv; the askpass env carries it to ssh-keygen', async () => {
    const root = tmp()
    const calls: { file: string; args: readonly string[]; env?: Record<string, string> }[] = []
    const exec: ExecFile = async (file, args, options) => {
      calls.push({ file, args, env: options?.env })
      if (file === 'ssh-keygen' && args[0] === '-p') {
        // The askpass contract exists while ssh-keygen runs: a 0600 secret
        // file, a 0700 script, force-require, a non-empty DISPLAY.
        const env = options?.env ?? {}
        expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
        expect(env.DISPLAY).not.toBe('')
        const secretFile = env.DSH_SSH_SECRET_FILE!
        expect(statSync(secretFile).mode & 0o777).toBe(0o600)
        expect(statSync(env.SSH_ASKPASS!).mode & 0o777).toBe(0o700)
        expect(readFileSync(env.SSH_ASKPASS!, 'utf8')).toContain('DSH_SSH_SECRET_FILE')
        expect(readFileSync(secretFile, 'utf8')).toBe('old-passphrase')
        return { stdout: '', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-y') return { stdout: 'ssh-ed25519 AAAAPUB imported\n', stderr: '' }
      return { stdout: ' 256 SHA256:abc comment (ED25519)\n', stderr: '' }
    }
    const store = new CredentialStore(root, exec)
    await store.importKey('imported', 'PRIVATE-KEY-BYTES', 'old-passphrase')
    const keygen = calls.find(call => call.args[0] === '-p')!
    expect(keygen.args.slice(0, 4)).toEqual(['-p', '-N', '', '-f'])
    expect(String(keygen.args.at(-1))).toMatch(/keys\/[0-9a-f]{12}$/)
    expect(calls.every(call => !call.args.some(arg => arg.includes('old-passphrase')))).toBe(true)
    // The temp dir is always removed.
    expect(readdirSync(root).filter(name => name.startsWith('askpass-'))).toHaveLength(0)
  })

  it('imports a real encrypted ed25519 key and stores it unencrypted', async () => {
    const scratch = tmp()
    const source = join(scratch, 'import-me')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', 'correct-horse', '-C', 'import-test', '-f', source], { stdio: 'pipe' })
    const privateKey = readFileSync(source, 'utf8')

    const store = new CredentialStore(tmp())
    const view = await store.importKey('imported', privateKey, 'correct-horse')
    expect(view.kind).toBe('key')
    expect(view.publicKey).toContain('ssh-ed25519')
    // Stored material is unencrypted: `ssh-keygen -y` needs no passphrase.
    const stored = join(store.root, 'keys', view.id)
    expect(execFileSync('ssh-keygen', ['-y', '-f', stored], { stdio: 'pipe' }).toString()).toContain('ssh-ed25519')
    // A wrong passphrase is refused and leaves no key behind.
    await expect(store.importKey('bad', privateKey, 'not-the-passphrase'))
      .rejects.toMatchObject({ code: 'credential-import-failed' } satisfies Partial<CredentialError>)
    expect(store.list().filter(credential => credential.label === 'bad')).toHaveLength(0)
    expect(readdirSync(join(store.root, 'keys')).sort()).toEqual([view.id, `${view.id}.pub`])
  })
})
