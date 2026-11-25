import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { windowsOpenSshCommands, windowsOpenSshHelperArgs } from '../src/remote/initiator/windows-openssh.ts'
import { parseWslDistributions, wslExecutable, wslExecArgs } from '../src/remote/initiator/wsl.ts'

const fail = (message) => { throw new Error(message) }
const run = (file, args, input) => execFileSync(file, args, {
  input, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
})

async function probeHelper([config, alias, node, helper, workspace, digest, platform]) {
  if (!workspace?.startsWith('/') || !/^[a-f0-9]{64}$/u.test(digest ?? '') || !['linux', 'darwin'].includes(platform)) {
    fail('Helper probe requires canonical workspace, SHA-256 and Linux/macOS target')
  }
  const { SshRpcPeer, SSH_PROTOCOL_VERSION } = await import('@deepseek-ai/dsh-ssh/protocol')
  const { helloSchema } = await import('@deepseek-ai/dsh-ssh/schemas')
  if (SSH_PROTOCOL_VERSION !== 3) fail('Unsupported Helper protocol for this probe')
  const args = windowsOpenSshHelperArgs({ alias, node, helper, config })
  const { ssh } = windowsOpenSshCommands()
  if (!statSync(ssh).isFile()) fail('Windows OpenSSH client is unavailable')
  const child = spawn(ssh, ['-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const closed = new Promise(resolve => { child.once('close', resolve) })
  const peer = new SshRpcPeer(child.stdout, child.stdin, 64 * 1024 * 1024, 128)
  child.on('error', () => peer.close(new Error('Native OpenSSH could not start')))
  try {
    const hello = await peer.request('hello', { protocol: SSH_PROTOCOL_VERSION, workspace, leaseMs: 30_000 }, helloSchema, AbortSignal.timeout(15_000))
    if (hello.hash !== digest || hello.kind !== 'node-script' || hello.platform !== platform || hello.workspace !== workspace || hello.bootstrapHash !== undefined) {
      fail('Helper identity did not match the test fixture')
    }
    await peer.request('heartbeat', {}, z.null(), AbortSignal.timeout(5_000))
    await peer.request('close', {}, z.null(), AbortSignal.timeout(5_000))
    console.log('PASS: official Helper stdio RPC, identity, heartbeat and close acknowledgements')
  } catch {
    fail('Helper control-channel probe failed; check the explicit fixture, known host, Node and Helper')
  } finally {
    peer.close()
    child.stdin.destroy()
    child.stdout.destroy()
    child.kill()
    let timer
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.unref()
          reject(new Error('Windows OpenSSH child did not close within the probe deadline'))
        }, 5000)
      })])
    } finally { clearTimeout(timer) }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('BLOCKED: run this probe on a native Windows Node or Electron Host')
    return 2
  }
  const [backend, ...distributions] = process.argv.slice(2)
  if (backend === 'windows-openssh' && distributions.length === 0) {
    const { ssh, keygen, keyscan } = windowsOpenSshCommands()
    if (!statSync(keyscan).isFile()) fail('Windows OpenSSH keyscan is unavailable')
    const scratch = mkdtempSync(join(tmpdir(), 'dsh ssh probe '))
    try {
      const config = join(scratch, 'config')
      writeFileSync(config, '')
      const version = spawnSync(ssh, ['-V'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })
      if (version.status !== 0 || !/OpenSSH_for_Windows_/i.test(version.stderr ?? '')) fail('Windows OpenSSH version detection failed')
      const resolved = run(ssh, ['-F', config, '-G', 'localhost']).toString('utf8')
      if (!/^hostname localhost\r?$/m.test(resolved)) fail('ssh -G did not resolve the test alias')
      const key = join(scratch, 'temporary_key')
      run(keygen, ['-t', 'ed25519', '-N', '', '-f', key])
      run(keygen, ['-lf', `${key}.pub`])
      console.log('PASS: Windows OpenSSH config and disposable key tooling')
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  } else if (backend === 'windows-openssh-helper' && distributions.length === 7) {
    await probeHelper(distributions)
  } else if (backend === 'wsl-list' && distributions.length === 0) {
    const names = parseWslDistributions(run(wslExecutable(), ['--list', '--quiet']))
    console.log(JSON.stringify(names))
  } else if (backend === 'wsl' && distributions.length >= 2 && new Set(distributions).size === distributions.length) {
    const wsl = wslExecutable()
    const installed = parseWslDistributions(run(wsl, ['--list', '--quiet']))
    for (const distribution of distributions) wslExecArgs(installed, distribution, ['node'])
    const bytes = randomBytes(65537)
    for (const distribution of distributions) {
      const args = (...command) => wslExecArgs(installed, distribution, command)
      const runtime = JSON.parse(run(wsl, args('node', '-e', [
        "const { homedir, userInfo } = require('node:os')",
        'process.stdout.write(JSON.stringify({ platform: process.platform, version: process.version, executable: process.execPath, user: userInfo().username, home: homedir() }))',
      ].join('; '))).toString('utf8'))
      if (runtime?.platform !== 'linux' || !/^v\d+\.\d+\.\d+/u.test(runtime.version) || !runtime.executable?.startsWith('/')
        || typeof runtime.user !== 'string' || runtime.user.length === 0 || !runtime.home?.startsWith('/')) {
        fail('WSL did not report a Linux Node executable, default user and home')
      }
      run(wsl, args('ssh', '-V'))
      const result = run(wsl, args(runtime.executable, '-e', 'process.stdin.pipe(process.stdout)'), bytes)
      if (!bytes.equals(result)) fail('WSL stdio did not preserve the binary payload')
      console.log(`PASS: ${JSON.stringify(distribution)}: Node ${runtime.version}, validated default user/home, OpenSSH, binary stdio and EOF`)
    }
  } else {
    fail('usage: node scripts/probe-windows-ssh-initiator.mjs windows-openssh | windows-openssh-helper <fixture-ssh-config> <alias> <remote-node> <remote-helper> <canonical-workspace> <entry-sha256> <linux|darwin> | wsl-list | wsl <first-dist> <second-dist> [more-dist...]')
  }
  return 0
}

try { process.exitCode = await main() }
catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exitCode = 1
}
