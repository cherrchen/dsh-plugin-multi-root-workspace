/**
 * Loopback real-SSH evidence for the provider file-browsing wire path: a
 * user-space OpenSSH `sshd` on 127.0.0.1 with throwaway host/user keys, and
 * the production `SftpClient` reaching it through a generated `ssh_config`
 * passed via `-F` — the exact mechanism `listRemoteDirectories` uses for a
 * managed personal environment (`src/remote/personal/remote-paths.ts`).
 * `init`, `realpath`, `lstat` and `readdirBounded` are the same frame-layer
 * functions `RemoteFilesService.probe`/`list` invoke.
 *
 * Gated on `DSH_MULTI_ROOT_SSH_LOOPBACK=1` and a POSIX initiator with a
 * usable `sshd`; without it the file skips cleanly.
 *
 * Documented boundary: `SshEnvironmentManager.openFilesSftp` verifies the
 * deployment alias through `ssh -G <alias>` reading the *user's*
 * `~/.ssh/config` — that lookup is by design and cannot be redirected to an
 * isolated config, so the manager's identity pipeline is exercised only by
 * the in-process specs and the `DSH_MULTI_ROOT_SSH_LIVE` e2e, not here.
 */
import { execFileSync } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SftpClient } from '../src/remote/sftp.ts'

const ON = process.env.DSH_MULTI_ROOT_SSH_LOOPBACK === '1'
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd'].find(candidate => existsSync(candidate))
const loopDescribe = describe.skipIf(!ON || SSHD === undefined || process.platform === 'win32')

const keygen = (args: readonly string[]) => execFileSync('ssh-keygen', [...args], { stdio: ['ignore', 'pipe', 'pipe'] })

/** Grab an ephemeral 127.0.0.1 port the OS will not hand to anything else yet. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
  })
})

const reachable = (port: number) => new Promise<boolean>(resolve => {
  const probe = new Socket()
  probe.once('connect', () => { probe.destroy(); resolve(true) })
  probe.once('error', () => resolve(false))
  probe.setTimeout(300, () => { probe.destroy(); resolve(false) })
  probe.connect(port, '127.0.0.1')
})

loopDescribe('loopback sshd behind the real OpenSSH client', () => {
  let base = ''
  let tree = ''
  let configFile = ''
  let port = 0
  let sshd: ChildProcess | undefined

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'mrfw-loop-'))
    tree = join(base, 'tree')
    // Literal POSIX names the provider must carry verbatim: spaces, Unicode
    // and a literal backslash, plus a nested chain to prove child listings.
    for (const directory of ['space dir', 'unicode-测试目录', 'literal\\name', 'deep', 'deep/inner']) {
      mkdirSync(join(tree, directory), { recursive: true })
    }
    writeFileSync(join(tree, 'space dir', 'a file.txt'), 'space\n')
    writeFileSync(join(tree, 'unicode-测试目录', '深.txt'), 'unicode\n')
    writeFileSync(join(tree, 'deep', 'inner', 'leaf.txt'), 'leaf\n')
    const keyDir = join(base, 'keys')
    mkdirSync(keyDir)
    keygen(['-t', 'ed25519', '-f', join(keyDir, 'ssh_host_ed25519_key'), '-N', '', '-q'])
    keygen(['-t', 'ed25519', '-f', join(keyDir, 'id_ed25519'), '-N', '', '-q'])
    writeFileSync(join(base, 'authorized_keys'), readFileSync(join(keyDir, 'id_ed25519.pub'), 'utf8'), { mode: 0o600 })
    port = await freePort()
    const hostPub = readFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(join(base, 'known_hosts'), `[127.0.0.1]:${port} ${hostPub}\n`, { mode: 0o600 })
    // The managed ssh_config shape remote-paths generates under credentialRoot.
    configFile = join(base, 'ssh_config')
    writeFileSync(configFile, [
      `Host mrfw-loop`,
      `  HostName 127.0.0.1`,
      `  Port ${port}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${join(keyDir, 'id_ed25519')}`,
      `  IdentitiesOnly yes`,
      `  UserKnownHostsFile ${join(base, 'known_hosts')}`,
      `  StrictHostKeyChecking yes`,
      `  BatchMode yes`,
      `  ForwardAgent no`,
      `  UpdateHostKeys no`,
      ``,
    ].join('\n'), { mode: 0o600 })
    const sshdConfig = join(base, 'sshd_config')
    writeFileSync(sshdConfig, [
      `ListenAddress 127.0.0.1`,
      `Port ${port}`,
      `HostKey ${join(keyDir, 'ssh_host_ed25519_key')}`,
      `PidFile ${join(base, 'sshd.pid')}`,
      `UsePAM no`,
      `PasswordAuthentication no`,
      `KbdInteractiveAuthentication no`,
      `PubkeyAuthentication yes`,
      `AuthorizedKeysFile ${join(base, 'authorized_keys')}`,
      `StrictModes no`,
      `LogLevel VERBOSE`,
      `Subsystem sftp internal-sftp`,
      ``,
    ].join('\n'), { mode: 0o600 })
    sshd = spawn(SSHD!, ['-f', sshdConfig, '-D', '-e'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = Date.now() + 10_000
    while (!(await reachable(port))) {
      if (sshd.exitCode !== null) throw new Error(`loopback sshd exited with code ${sshd.exitCode}`)
      if (Date.now() > deadline) throw new Error('loopback sshd never opened its port')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }, 30_000)

  afterAll(async () => {
    sshd?.kill('SIGTERM')
    if (sshd !== undefined) await new Promise(resolve => { sshd!.once('exit', resolve); setTimeout(resolve, 3_000) })
    rmSync(base, { recursive: true, force: true })
  })

  it('negotiates SFTP v3 and lists root, nested and literal POSIX names verbatim', async () => {
    const client = SftpClient.connect('mrfw-loop', { configFile })
    try {
      const version = await client.init()
      expect(version.version).toBe(3)
      const signal = new AbortController().signal
      const root = await client.readdirBounded(tree, signal)
      expect(root.truncated).toBe(false)
      expect(root.entries).toEqual(expect.arrayContaining([
        { name: 'space dir', type: 'directory' },
        { name: 'unicode-测试目录', type: 'directory' },
        { name: 'literal\\name', type: 'directory' },
        { name: 'deep', type: 'directory' },
      ]))
      const nested = await client.readdirBounded(join(tree, 'deep', 'inner'), signal)
      expect(nested.entries).toEqual([{ name: 'leaf.txt', type: 'file' }])
      // The literal backslash name survives realpath/lstat byte-exact —
      // realpath also canonicalizes the macOS /var symlink, so compare to the
      // host-canonical spelling, not the fixture's own path.
      const literal = join(tree, 'literal\\name')
      expect(await client.realpath(literal)).toBe(realpathSync(literal))
      const attrs = await client.lstat(literal)
      expect(attrs.permissions! & 0o170000).toBe(0o040000)
      const spaced = await client.readdirBounded(join(tree, 'space dir'), signal)
      expect(spaced.entries).toEqual([{ name: 'a file.txt', type: 'file' }])
    } finally {
      await client.dispose()
    }
  })
})
