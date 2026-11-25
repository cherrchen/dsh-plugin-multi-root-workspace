/**
 * The real endpoint verifier: a binding is registered only after a read-only
 * confined probe on the remote itself proves the path is the directory the
 * manifest declares — no symlink, no mount redirect — and yields the durable
 * identity (dev:ino) the grant pins to.
 */
import type { RemoteEndpointVerifier } from './contract.ts'
import { environmentDigest, type RemoteBinding, type RemoteEnvironment } from './manifest.ts'
import type { SshEnvironment, SftpEnvironment } from './ssh-environment.ts'

/** The connection openings verification needs; the SSH manager implements it. */
export interface SshEndpointManager {
  open(environmentId: string, workspace?: string, expectedDigest?: string): Promise<SshEnvironment>
  openSftp(environmentId: string, signal?: AbortSignal, expectedDigest?: string): Promise<SftpEnvironment>
  /** An owned browse channel (ADR-0052 P3); a broker or test manager may not have one. */
  openFilesSftp?(environmentId: string, signal: AbortSignal, expectedDigest: string): Promise<SftpEnvironment & { live(): boolean }>
}

/** Verification errors keep the registry's RemoteAdmissionError codes. */
export class EndpointVerifyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EndpointVerifyError'
  }
}

export class SshEndpointVerifier implements RemoteEndpointVerifier {
  constructor(private readonly manager: SshEndpointManager) {}

  async verify(environment: RemoteEnvironment, binding: Pick<RemoteBinding, 'path' | 'directoryListing'>, signal: AbortSignal, workspace = binding.path): Promise<{ platform: 'linux' | 'darwin'; target: { kind: 'object' | 'path'; value: string } }> {
    if (environment.transport === 'sftp') return await this.verifySftp(environment, binding, signal)
    if (signal.aborted) throw new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')
    const env = await this.manager.open(environment.environmentId, workspace, environmentDigest(environment))
    if (signal.aborted) throw new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')
    const policy = { mode: 'read-only' as const, workspaceRoot: workspace, sessionId: 'endpoint-verification' }
    const confined = await env.sandbox.confine([String(env.hello.executable), '-e',
      `const fs=require('node:fs');const s=fs.statSync(process.argv[1],{bigint:true});process.stdout.write(JSON.stringify({real:fs.realpathSync(process.argv[1]),dev:String(s.dev),ino:String(s.ino),isDirectory:s.isDirectory()}))`,
      binding.path], policy, signal)
    if (confined.enforcement !== 'full') throw new EndpointVerifyError('endpoint-unverifiable', `read-only confinement on "${environment.environmentId}" is not full`)
    if (signal.aborted) throw new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')
    const handle = env.subprocess.spawn({
      argv: confined.argv, cwd: binding.path,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const done = handle.done as Promise<{ exitCode: number }>
      void done.catch(() => {})
      const finished = await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new EndpointVerifyError('endpoint-unverifiable', 'verification aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EndpointVerifyError('endpoint-unverifiable', 'verification timed out')), 30_000) }),
      ])
      if (finished.exitCode !== 0) throw new EndpointVerifyError('endpoint-unverifiable', `the remote stat probe exited ${finished.exitCode}`)
      const collected = handle.collected as { stdout?: { readFrom(offset: number): { text: string } } }
      const probe = JSON.parse(collected.stdout!.readFrom(0).text) as { real: string; dev: string; ino: string; isDirectory: boolean }
      if (!probe.isDirectory) throw new EndpointVerifyError('endpoint-unverifiable', `${binding.path} is not a directory`)
      if (probe.real !== binding.path) throw new EndpointVerifyError('endpoint-redirected', `${binding.path} resolves to "${probe.real}"`)
      // Directory browsing is a separate path-identity admission. A Helper
      // grant remains object-targeted for exec/copy; when the binding opts in,
      // registration additionally proves the declared path through the same
      // owned SFTP v3 channel shape a Helper-less endpoint uses. Browsing never
      // reinterprets dev:ino as a path grant — it relies on this second check
      // plus the binding's explicit stable-path deployment assertion.
      if (binding.directoryListing === 'stable-path') await this.verifySftp(environment, binding, signal)
      return { platform: env.hello.platform as 'linux' | 'darwin', target: { kind: 'object', value: `${probe.dev}:${probe.ino}` } }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      try { handle.terminate() } catch { /* already gone */ }
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          handle.waitForExit(AbortSignal.timeout(500)).catch(() => false),
          new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), 550) }),
        ])
      } finally { if (bound !== undefined) clearTimeout(bound) }
    }
  }

  /**
   * The SFTP path probe: realpath must equal the declared path and lstat must
   * name a directory. Helper-less endpoints use it as their registration
   * identity; Helper endpoints use it only as the additional browse admission
   * for an opted-in binding. Path-only identity cannot detect a same-name swap
   * at publish time — SFTP v3 has no inode — which is why browsing remains an
   * explicit stable-path deployment assertion.
   */
  private async verifySftp(environment: RemoteEnvironment, binding: Pick<RemoteBinding, 'path' | 'directoryListing'>, signal: AbortSignal): Promise<{ platform: 'linux' | 'darwin'; target: { kind: 'object' | 'path'; value: string } }> {
    // An opt-in binding verifies through an OWNED files channel: a listing
    // abort closes only this channel, never the shared or a copy's session.
    const owned = binding.directoryListing === 'stable-path' && typeof this.manager.openFilesSftp === 'function'
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), 30_000)
    timer.unref()
    const combined = AbortSignal.any([signal, deadline.signal])
    const env = owned
      ? await this.manager.openFilesSftp!(environment.environmentId, combined, environmentDigest(environment))
      : await this.manager.openSftp(environment.environmentId, combined, environmentDigest(environment))
    try {
      if (combined.aborted) throw new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')
      const real = await env.client.realpath(binding.path).catch((error: unknown) => {
        throw new EndpointVerifyError('endpoint-unverifiable', `realpath failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (real !== binding.path) throw new EndpointVerifyError('endpoint-redirected', `${binding.path} resolves to "${real}"`)
      const attrs = await env.client.lstat(binding.path).catch((error: unknown) => {
        throw new EndpointVerifyError('endpoint-unverifiable', `lstat failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      if ((attrs.permissions! & 0o170000) !== 0o040000) throw new EndpointVerifyError('endpoint-unverifiable', `${binding.path} is not a directory`)
      return { platform: environment.platform as 'linux' | 'darwin', target: { kind: 'path', value: binding.path } }
    } finally {
      clearTimeout(timer)
      if (owned) await env.dispose().catch(() => {})
    }
  }
}
