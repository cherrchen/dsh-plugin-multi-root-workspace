/**
 * The real endpoint verifier: a binding is registered only after a read-only
 * confined probe on the remote itself proves the path is the directory the
 * manifest declares — no symlink, no mount redirect — and yields the durable
 * identity (dev:ino) the grant pins to.
 */
import type { RemoteEndpointVerifier } from './contract.ts'
import type { RemoteBinding, RemoteEnvironment } from './manifest.ts'
import type { SshEnvironmentManager } from './ssh-environment.ts'

/** Verification errors keep the registry's RemoteAdmissionError codes. */
export class EndpointVerifyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EndpointVerifyError'
  }
}

export class SshEndpointVerifier implements RemoteEndpointVerifier {
  constructor(private readonly manager: SshEnvironmentManager) {}

  async verify(environment: RemoteEnvironment, binding: RemoteBinding, signal: AbortSignal): Promise<{ platform: 'linux' | 'darwin'; target: { kind: 'object' | 'path'; value: string } }> {
    if (environment.transport === 'sftp') return await this.verifySftp(environment, binding, signal)
    const env = await this.manager.open(environment.environmentId)
    const policy = { mode: 'read-only' as const, workspaceRoot: binding.path }
    const confined = await env.sandbox.confine([String(env.hello.executable), '-e',
      `const fs=require('node:fs');const s=fs.statSync(process.argv[1],{bigint:true});process.stdout.write(JSON.stringify({real:fs.realpathSync(process.argv[1]),dev:String(s.dev),ino:String(s.ino),isDirectory:s.isDirectory()}))`,
      binding.path], policy, signal)
    if (confined.enforcement !== 'full') throw new EndpointVerifyError('endpoint-unverifiable', `read-only confinement on "${environment.environmentId}" is not full`)
    const handle = env.subprocess.spawn({
      argv: confined.argv, cwd: binding.path,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
      graceMs: 500,
    })
    const done = await Promise.race([
      handle.done as Promise<{ exitCode: number }>,
      new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')), { once: true }) }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new EndpointVerifyError('endpoint-unverifiable', 'verification timed out')), 30_000) }),
    ])
    if (done.exitCode !== 0) throw new EndpointVerifyError('endpoint-unverifiable', `the remote stat probe exited ${done.exitCode}`)
    const collected = handle.collected as { stdout?: { readFrom(offset: number): { text: string } } }
    const probe = JSON.parse(collected.stdout!.readFrom(0).text) as { real: string; dev: string; ino: string; isDirectory: boolean }
    if (!probe.isDirectory) throw new EndpointVerifyError('endpoint-unverifiable', `${binding.path} is not a directory`)
    if (probe.real !== binding.path) throw new EndpointVerifyError('endpoint-redirected', `${binding.path} resolves to "${probe.real}"`)
    return { platform: env.hello.platform as 'linux' | 'darwin', target: { kind: 'object', value: `${probe.dev}:${probe.ino}` } }
  }

  /**
   * SFTP endpoints carry no helper handshake: realpath must equal the declared
   * path and lstat must name a directory. Identity is path-only — SFTP v3 has
   * no inode, so a same-name swap at publish time cannot be detected here; the
   * manifest's declared platform stands in for the absent remote handshake.
   */
  private async verifySftp(environment: RemoteEnvironment, binding: RemoteBinding, signal: AbortSignal): Promise<{ platform: 'linux' | 'darwin'; target: { kind: 'object' | 'path'; value: string } }> {
    const env = await this.manager.openSftp(environment.environmentId)
    if (signal.aborted) throw new EndpointVerifyError('endpoint-unverifiable', 'verification aborted')
    const real = await env.client.realpath(binding.path).catch((error: unknown) => {
      throw new EndpointVerifyError('endpoint-unverifiable', `realpath failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (real !== binding.path) throw new EndpointVerifyError('endpoint-redirected', `${binding.path} resolves to "${real}"`)
    const attrs = await env.client.lstat(binding.path).catch((error: unknown) => {
      throw new EndpointVerifyError('endpoint-unverifiable', `lstat failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    if ((attrs.permissions! & 0o170000) !== 0o040000) throw new EndpointVerifyError('endpoint-unverifiable', `${binding.path} is not a directory`)
    return { platform: environment.platform as 'linux' | 'darwin', target: { kind: 'path', value: binding.path } }
  }
}
