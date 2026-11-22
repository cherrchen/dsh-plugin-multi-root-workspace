/** SshEnvironmentManager refusal ordering — injected exec/readFile, no network. */
import { describe, expect, it, vi } from 'vitest'
import { hostKeyFingerprint, parseSshConfig, SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { SftpClient } from '../src/remote/sftp.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'

const SSH_G = [
  'user dshbuild', 'hostname 203.0.113.95', 'userknownhostsfile /home/t/.dsh-ssh-test/known_hosts',
  'stricthostkeychecking yes', 'forwardagent no', 'batchmode yes', 'identityfile ~/.dsh-ssh-test/dshbuild_ed25519',
].join('\n')
const KEY_LINE = '203.0.113.95 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFakeKeyDataForUnitTestOnly123456'
const FP = 'SHA256:ZVJcb8gU2m2/IDlL0Zq4y2dzsJxbaMKHqm12KbIQ8D0'
const environment = (over: object = {}) => ({
  environmentId: 'vps-app', platform: 'linux', account: 'dshbuild', hostKey: FP,
  namespace: 'ns', transport: 'helper' as const, helper: { sha256: 'a'.repeat(64), protocol: 1 },
  connection: { host: 'dsh-vps-build', nodePath: '/opt/node-v24/bin/node', helperPath: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', workspace: '/srv/dsh/work/app' },
  credentialIsolation: 'unattested' as const, ...over,
})
const manifest = (envs: readonly object[] = [environment()]): DeploymentManifest => ({ schemaVersion: 1, configVersion: 'c', environments: envs as never, bindings: [] })
const calls: string[] = []
const exec = async (file: string, args: readonly string[], _input?: string) => {
  calls.push(`${file} ${args.join(' ')}`)
  if (file === 'ssh' && args[0] === '-G') return { stdout: SSH_G, stderr: '' }
  if (file === 'ssh-keygen' && args[0] === '-F') return { stdout: `${KEY_LINE}\n`, stderr: '' }
  if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP} comment (ED25519)\n`, stderr: '' }
  return { stdout: '', stderr: '' }
}
const logger = { debug: () => {}, warn: () => {} }
const eligible = { status: 'eligible' as const, release: '0.2.2-rc.1' }

describe('parseSshConfig', () => {
  it('parses the fields that bind the host identity', () => {
    expect(parseSshConfig(SSH_G)).toMatchObject({ user: 'dshbuild', hostname: '203.0.113.95', strictHostKeyChecking: 'yes', forwardAgent: 'no' })
    expect(() => parseSshConfig('hostname x\nstricthostkeychecking yes\nuser u\nbatchmode yes\nforwardagent no')).not.toThrow()
    expect(() => parseSshConfig('user u\nhostname x\nstricthostkeychecking ask')).toThrowError(/strictHostKeyChecking/)
    expect(() => parseSshConfig('stricthostkeychecking yes')).toThrowError(/no user/)
  })

  it('names the known_hosts lookup OpenSSH-style: HostKeyAlias verbatim else [hostname]:port', () => {
    expect(parseSshConfig(SSH_G).lookupHost).toBe('203.0.113.95')
    expect(parseSshConfig(`${SSH_G}\nport 2222`).lookupHost).toBe('[203.0.113.95]:2222')
    expect(parseSshConfig(`${SSH_G}\nport 2222\nhostkeyalias deploy-key`).lookupHost).toBe('deploy-key')
    expect(parseSshConfig(`${SSH_G}\nport 2222\nhostkeyalias none`).lookupHost).toBe('none')
  })

  it('refuses settings that could rewrite or bypass host-key verification', () => {
    // `ssh -G` normalizes UpdateHostKeys: no->false, yes->true, ask->ask.
    // Only the resolved "never rewrite" spellings pass.
    expect(parseSshConfig(`${SSH_G}\nupdatehostkeys no`).updateHostKeys).toBe('no')
    expect(parseSshConfig(`${SSH_G}\nupdatehostkeys false`).updateHostKeys).toBe('false')
    for (const value of ['yes', 'true', 'ask']) {
      expect(() => parseSshConfig(`${SSH_G}\nupdatehostkeys ${value}`)).toThrowError(/updateHostKeys/)
    }
    expect(() => parseSshConfig(`${SSH_G}\nbatchmode no`)).toThrowError(/batchMode/)
    expect(() => parseSshConfig(`${SSH_G}\nforwardagent yes`)).toThrowError(/forwardAgent/)
    expect(() => parseSshConfig(`${SSH_G}\nstricthostkeychecking accept-new`)).toThrowError(/strictHostKeyChecking/)
  })

  it('collects every active user and global known_hosts source', () => {
    const parsed = parseSshConfig(`${SSH_G}\nglobalknownhostsfile /etc/ssh/ssh_known_hosts /dev/null`)
    expect(parsed.knownHostsFiles).toEqual(['/home/t/.dsh-ssh-test/known_hosts'])
    expect(parsed.globalKnownHostsFiles).toEqual(['/etc/ssh/ssh_known_hosts'])
  })
})

describe('hostKeyFingerprint', () => {
  it('requires exactly one key and reports the fingerprint', async () => {
    expect(await hostKeyFingerprint('203.0.113.95', ['/kh'], exec)).toEqual({ keys: 1, fingerprint: FP })
    expect(await hostKeyFingerprint('h', ['/kh'], async () => ({ stdout: '', stderr: '' }))).toEqual({ keys: 0, fingerprint: undefined })
    expect(await hostKeyFingerprint('h', ['/kh'], async (f, a) => a[0] === '-F' ? { stdout: `${KEY_LINE}\n${KEY_LINE}\n`, stderr: '' } : { stdout: '', stderr: '' })).toEqual({ keys: 2, fingerprint: undefined })
  })
})

describe('SshEnvironmentManager refusal ordering', () => {
  const open = async (opts: Parameters<typeof SshEnvironmentManager.prototype.open>[0] extends never ? never : { env?: object; gate?: object; allow?: boolean }, id = 'vps-app') => {
    const manager = new SshEnvironmentManager({
      manifest: manifest([opts.env === undefined ? environment() : opts.env as never]),
      logger, gate: opts.gate as never ?? eligible,
      allowUnattestedForTesting: opts.allow,
      exec, readFile: () => KEY_LINE,
    })
    return await manager.open(id)
  }
  it('refuses a non-eligible gate before ssh -G runs', async () => {
    calls.length = 0
    await expect(open({ gate: { status: 'absent', reason: 'host-below-floor', detail: 'x', packages: [] } })).rejects.toMatchObject({ code: 'ssh-capability-absent:host-below-floor' })
    expect(calls.filter(call => call.startsWith('ssh -G'))).toHaveLength(0)
  })
  it('refuses sftp transport and unattested isolation before identity work', async () => {
    calls.length = 0
    await expect(open({ env: environment({ transport: 'sftp', helper: null, connection: { host: 'dsh-vps-xfer' } }) })).rejects.toMatchObject({ code: 'transport-not-helper' })
    await expect(open({ allow: false })).rejects.toMatchObject({ code: 'credential-isolation-unattested' })
    expect(calls.filter(call => call.startsWith('ssh -G'))).toHaveLength(0)
  })
  it('refuses a personal helper that predates full-artifact integrity', async () => {
    const manager = new SshEnvironmentManager({
      manifest: manifest([environment()]), logger, gate: eligible, custody: 'personal', exec, readFile: () => KEY_LINE,
    })
    await expect(manager.open('vps-app')).rejects.toMatchObject({ code: 'helper-outdated' })
    expect(calls.filter(call => call.startsWith('ssh -G'))).toHaveLength(0)
    const upgraded = new SshEnvironmentManager({
      manifest: manifest([environment({ helper: { sha256: 'a'.repeat(64), protocol: 1, integrity: 2 as const, treeSha256: 'b'.repeat(64) } })]),
      logger, gate: eligible, custody: 'personal', exec, readFile: () => KEY_LINE,
    })
    // Past the integrity gate, the next refusal is the personal workspace check.
    await expect(upgraded.open('vps-app')).rejects.toMatchObject({ code: 'workspace-invalid' })
  })
  it('refuses account and host-key drift after ssh -G but before loading modules', async () => {
    await expect(open({ allow: true, env: environment({ account: 'other' }) })).rejects.toMatchObject({ code: 'account-mismatch' })
    await expect(open({ allow: true, env: environment({ hostKey: `SHA256:${'B'.repeat(43)}` }) })).rejects.toMatchObject({ code: 'host-key-mismatch' })
  })

  it('verifies the key under HostKeyAlias verbatim and never under the resolved hostname', async () => {
    const lookups: string[] = []
    const execAlias = async (file: string, args: readonly string[]) => {
      if (file === 'ssh' && args[0] === '-G') return { stdout: `${SSH_G}\nhostkeyalias deploy-key`, stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-F') {
        lookups.push(args[1]!)
        return { stdout: args[1] === 'deploy-key' ? `${KEY_LINE}\n` : '', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP} comment (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const manager = new SshEnvironmentManager({
      manifest: manifest(), logger, gate: eligible, allowUnattestedForTesting: true, exec: execAlias, readFile: () => KEY_LINE,
    })
    await expect(manager.open('vps-app')).rejects.toSatisfy((error: unknown) => {
      const code = (error as { code?: string }).code ?? ''
      return !code.startsWith('host-key') && !code.startsWith('host-identity') && !code.startsWith('account-')
    })
    expect(lookups).toEqual(['deploy-key'])
  })

  it('looks a non-22 port host up as [hostname]:port', async () => {
    const lookups: string[] = []
    const execPort = async (file: string, args: readonly string[]) => {
      if (file === 'ssh' && args[0] === '-G') return { stdout: `${SSH_G}\nport 2222`, stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-F') {
        lookups.push(args[1]!)
        return { stdout: args[1] === '[203.0.113.95]:2222' ? `${KEY_LINE}\n` : '', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP} comment (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const manager = new SshEnvironmentManager({
      manifest: manifest(), logger, gate: eligible, allowUnattestedForTesting: true, exec: execPort, readFile: () => KEY_LINE,
    })
    await expect(manager.open('vps-app')).rejects.toSatisfy((error: unknown) => {
      const code = (error as { code?: string }).code ?? ''
      return !code.startsWith('host-key') && !code.startsWith('host-identity') && !code.startsWith('account-')
    })
    expect(lookups).toEqual(['[203.0.113.95]:2222'])
  })
})


describe('shared SFTP openings', () => {
  it('cancels only the waiting caller and retains the live generation on an unrelated rebind', async () => {
    const connection = environment({ transfer: { maxBytes: 1024, timeoutMs: 10_000 } })
    const manager = new SshEnvironmentManager({
      manifest: manifest([connection]), logger, gate: eligible, custody: 'personal', exec, readFile: () => KEY_LINE,
    })
    const entered = Promise.withResolvers<void>()
    const handshake = Promise.withResolvers<{ version: number; extensions: Record<string, string> }>()
    const client = { init: () => { entered.resolve(); return handshake.promise }, dispose: vi.fn() }
    const connect = vi.spyOn(SftpClient, 'connect').mockReturnValue(client as never)
    const controller = new AbortController()
    try {
      const first = manager.openSftp('vps-app', controller.signal)
      const second = manager.openSftp('vps-app')
      await entered.promise
      controller.abort()
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      handshake.resolve({ version: 3, extensions: { 'hardlink@openssh.com': '1', 'fsync@openssh.com': '1' } })
      const opened = await second
      expect(connect).toHaveBeenCalledTimes(1)
      expect(client.dispose).not.toHaveBeenCalled()

      manager.rebind(manifest([{ ...connection, displayName: 'Renamed' }, environment({ environmentId: 'vps-other' })]))
      expect(await manager.openSftp('vps-app')).toBe(opened)
      expect(manager.sftpGenerationOf('vps-app')).toBe(opened.generation)

      manager.rebind(manifest([{ ...connection, hostKey: `SHA256:${'B'.repeat(43)}` }]))
      expect(manager.sftpGenerationOf('vps-app')).toBe('stale')
      await expect.poll(() => client.dispose.mock.calls.length).toBe(1)
    } finally {
      await manager.disposeAll()
      connect.mockRestore()
    }
  })
})


it('gives simultaneous copies separate SFTP channels', async () => {
  const connection = environment({ transfer: { maxBytes: 1024, timeoutMs: 10_000 } })
  const manager = new SshEnvironmentManager({
    manifest: manifest([connection]), logger, gate: eligible, custody: 'personal', exec, readFile: () => KEY_LINE,
  })
  const clients: { dispose: ReturnType<typeof vi.fn> }[] = []
  const connect = vi.spyOn(SftpClient, 'connect').mockImplementation(() => {
    const client = { init: async () => ({ version: 3, extensions: { 'hardlink@openssh.com': '1', 'fsync@openssh.com': '1' } }), dispose: vi.fn() }
    clients.push(client)
    return client as never
  })
  try {
    const signal = new AbortController().signal
    const first = await manager.openTransferSftp('vps-app', signal)
    const second = await manager.openTransferSftp('vps-app', signal)
    expect(second.generation).not.toBe(first.generation)
    await first.dispose()
    expect(first.live()).toBe(false)
    expect(second.live()).toBe(true)
    expect(clients[1]!.dispose).not.toHaveBeenCalled()
  } finally {
    await manager.disposeAll()
    connect.mockRestore()
  }
})
