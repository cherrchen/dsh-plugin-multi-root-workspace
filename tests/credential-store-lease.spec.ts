/**
 * `credentials.json` mutations run under the same kernel lease the personal
 * config uses (ADR-0007): two Host processes (two `CredentialStore` instances
 * on one root) cannot lose each other's records — a contended write refuses
 * `credential-store-busy` instead of overwriting.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, type ExecFile } from '../src/remote/personal/credentials.ts'
import { RegistryAuthorityLease } from '../src/registry-lease.ts'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'cred-lease-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const fakeExec: ExecFile = async (file, args) => {
  if (file === 'ssh-keygen' && args[0] === '-t') {
    const keyPath = String(args.at(-1))
    writeFileSync(keyPath, 'PRIV', { mode: 0o600 })
    writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAPUB\n', { mode: 0o644 })
    return { stdout: '', stderr: '' }
  }
  return { stdout: ' 256 SHA256:abc comment (ED25519)\n', stderr: '' }
}

/** Retry a mutation while a sibling Host holds the lease — the lock owner releases in milliseconds. */
const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await run() } catch (error) {
      if ((error as { code?: string }).code !== 'credential-store-busy') throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  return await run()
}

describe.skipIf(process.platform === 'win32')('CredentialStore cross-Host lease', () => {
  it('a contended write refuses credential-store-busy instead of losing the other record', async () => {
    const root = tmp()
    const store = new CredentialStore(root, fakeExec)
    const lease = await RegistryAuthorityLease.acquire(join(root, 'credentials.json.lock'))
    try {
      await expect(store.savePassword('held', 'pw')).rejects.toMatchObject({ code: 'credential-store-busy' })
      await expect(store.remove('anything', () => false)).rejects.toMatchObject({ code: 'credential-store-busy' })
    } finally {
      await lease.release()
    }
    await store.savePassword('held', 'pw')
    expect(store.list().map(credential => credential.label)).toEqual(['held'])
  })

  it('two store instances on one root never lose concurrent records', async () => {
    const root = tmp()
    mkdirSync(root, { recursive: true })
    const first = new CredentialStore(root, fakeExec)
    const second = new CredentialStore(root, fakeExec)
    const labels = Array.from({ length: 8 }, (_, index) => `key-${index}`)
    await Promise.all(labels.map((label, index) => withRetry(async () => {
      const store = index % 2 === 0 ? first : second
      if (index % 3 === 0) await store.generate(label)
      else await store.savePassword(label, `pw-${index}`)
    })))
    expect(first.list().map(credential => credential.label).sort()).toEqual([...labels].sort())
    expect(second.list()).toHaveLength(8)
  })

  it('a remove under contention retries and removes exactly once', async () => {
    const root = tmp()
    const store = new CredentialStore(root, fakeExec)
    const view = await store.savePassword('gone', 'pw')
    const lease = await RegistryAuthorityLease.acquire(join(root, 'credentials.json.lock'))
    const pending = withRetry(() => store.remove(view.id, () => false))
    await new Promise(resolve => setTimeout(resolve, 10))
    await lease.release()
    await pending
    expect(store.list()).toHaveLength(0)
  })
})
