/**
 * Personal custody credential root (ADR-0041 §2): `<credentialRoot>` 0700,
 * `credentials.json` metadata 0600, `keys/<id>` 0600 + `keys/<id>.pub` 0644,
 * `secrets/<id>` 0600. No function ever returns private key or password
 * material — `list()` answers metadata only.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** External command seam — every ssh-keygen call is injectable for tests. */
export type ExecFile = (file: string, args: readonly string[], options?: { input?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>

export class CredentialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

export interface CredentialView {
  readonly id: string
  readonly label: string
  readonly kind: 'key' | 'password'
  readonly publicKey?: string | undefined
  readonly fingerprint?: string | undefined
  readonly createdAt: string
  /** Set on auto-generated per-environment access keys; the UI groups them. */
  readonly purpose?: 'access-key' | undefined
  readonly environmentId?: string | undefined
}

interface CredentialRecord extends CredentialView {
  readonly secretFile?: string | undefined
}

const newId = (): string => randomBytes(6).toString('hex')

/**
 * Open (and create) the credential root. Refuses `credential-root-unsafe`
 * when it exists but is not owned by the current uid or is group/other
 * accessible.
 */
export class CredentialStore {
  constructor(readonly root: string, private readonly exec: ExecFile = defaultExec) {
    if (typeof process.getuid !== 'function') throw new CredentialError('credential-root-unsafe', 'credential protection checks require a POSIX host')
    const uid = process.getuid()
    if (existsSync(root)) {
      const info = lstatSync(root)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
        throw new CredentialError('credential-root-unsafe', `the credential root "${root}" must be a real directory owned by the current user with mode 0700`)
      }
    } else {
      mkdirSync(root, { recursive: true, mode: 0o700 })
    }
    for (const sub of ['keys', 'secrets']) {
      const dir = join(root, sub)
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
    }
  }

  private recordsPath(): string { return join(this.root, 'credentials.json') }

  private records(): CredentialRecord[] {
    if (!existsSync(this.recordsPath())) return []
    const data = JSON.parse(readFileSync(this.recordsPath(), 'utf8')) as unknown
    return Array.isArray(data) ? data as CredentialRecord[] : []
  }

  private save(records: readonly CredentialRecord[]): void {
    writeFileSync(this.recordsPath(), JSON.stringify(records, null, 2), { mode: 0o600 })
  }

  /** Metadata only — never key or password bytes. */
  list(): CredentialView[] {
    return this.records().map(({ secretFile: _secret, ...view }) => view)
  }

  /** Generate an ed25519 keypair with an empty passphrase. */
  async generate(label: string, meta?: { purpose: 'access-key'; environmentId: string }): Promise<CredentialView> {
    const id = newId()
    const keyPath = join(this.root, 'keys', id)
    await this.exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `dsh-${id}`, '-f', keyPath], { timeoutMs: 30_000 })
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const fingerprint = await this.fingerprintOf(keyPath)
    const record: CredentialRecord = { id, label, kind: 'key', publicKey, fingerprint, createdAt: new Date().toISOString(), ...(meta === undefined ? {} : meta) }
    this.save([...this.records(), record])
    return { id, label, kind: 'key', publicKey, fingerprint, createdAt: record.createdAt, ...(meta === undefined ? {} : meta) }
  }

  /**
   * Import private key material. An encrypted key requires `passphrase`,
   * which is stripped before storage; it travels only inside ssh-keygen argv
   * and is never echoed in errors.
   */
  async importKey(label: string, privateKey: string, passphrase?: string): Promise<CredentialView> {
    const id = newId()
    const keyPath = join(this.root, 'keys', id)
    writeFileSync(keyPath, privateKey, { mode: 0o600 })
    try {
      if (passphrase === undefined) {
        // Unencrypted: `ssh-keygen -y` both validates and derives the public key.
        const { stdout } = await this.exec('ssh-keygen', ['-y', '-f', keyPath], { timeoutMs: 30_000 })
        writeFileSync(`${keyPath}.pub`, `${stdout.trim()}\n`, { mode: 0o644 })
      } else {
        await this.exec('ssh-keygen', ['-p', '-P', passphrase, '-N', '', '-f', keyPath], { timeoutMs: 30_000 })
        const { stdout } = await this.exec('ssh-keygen', ['-y', '-f', keyPath], { timeoutMs: 30_000 })
        writeFileSync(`${keyPath}.pub`, `${stdout.trim()}\n`, { mode: 0o644 })
      }
    } catch (error) {
      rmSync(keyPath, { force: true })
      rmSync(`${keyPath}.pub`, { force: true })
      throw new CredentialError('credential-import-failed', `the private key could not be imported: ${error instanceof Error ? error.message : String(error)}`)
    }
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const fingerprint = await this.fingerprintOf(keyPath)
    const record: CredentialRecord = { id, label, kind: 'key', publicKey, fingerprint, createdAt: new Date().toISOString() }
    this.save([...this.records(), record])
    return { id, label, kind: 'key', publicKey, fingerprint, createdAt: record.createdAt }
  }

  /** Store a password (0600 under secrets/). */
  savePassword(label: string, password: string): CredentialView {
    const id = newId()
    const secretFile = join(this.root, 'secrets', id)
    writeFileSync(secretFile, password, { mode: 0o600 })
    const record: CredentialRecord = { id, label, kind: 'password', secretFile, createdAt: new Date().toISOString() }
    this.save([...this.records(), record])
    return { id, label, kind: 'password', createdAt: record.createdAt }
  }

  /** The secret file path — for the askpass helper env only, never to clients. */
  secretFileOf(id: string): string | undefined {
    return this.records().find(record => record.id === id)?.secretFile ?? undefined
  }

  keyPathOf(id: string): string { return join(this.root, 'keys', id) }

  /** Refuse `credential-in-use` while a personal environment references it. */
  remove(id: string, inUse: (credentialId: string) => boolean): void {
    if (inUse(id)) throw new CredentialError('credential-in-use', `credential ${id} is still referenced by a remote environment`)
    const next = this.records().filter(record => record.id !== id)
    if (next.length === this.records().length) throw new CredentialError('credential-not-found', `no credential ${id}`)
    rmSync(join(this.root, 'keys', id), { force: true })
    rmSync(`${join(this.root, 'keys', id)}.pub`, { force: true })
    rmSync(join(this.root, 'secrets', id), { force: true })
    this.save(next)
  }

  private async fingerprintOf(keyPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec('ssh-keygen', ['-lf', keyPath], { timeoutMs: 30_000 })
      const match = /(SHA256:[A-Za-z0-9+/=]+)/.exec(stdout)
      return match?.[1]
    } catch {
      return undefined
    }
  }
}

import { execFile } from 'node:child_process'

/** The real command seam: execFile, captured stdio, 30 s default timeout. */
export const defaultExec: ExecFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], {
    env: options?.env === undefined ? process.env : { ...process.env, ...options.env },
    timeout: options?.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error !== null) reject(error instanceof Error ? error : new Error(String(error)))
    else resolve({ stdout, stderr })
  })
})
