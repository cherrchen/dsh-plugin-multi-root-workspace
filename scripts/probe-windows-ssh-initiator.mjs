import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const fail = (message) => { throw new Error(message) }
const run = (file, args, input) => execFileSync(file, args, {
  input, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
})

function main() {
  if (process.platform !== 'win32') {
    console.log('BLOCKED: run this probe on a native Windows Node or Electron Host')
    return 2
  }
  const [backend, ...distributions] = process.argv.slice(2)
  const root = process.env.SystemRoot
  if (root === undefined || !isAbsolute(root)) fail('Windows SystemRoot is unavailable')
  const system32 = join(root, 'System32')
  if (backend === 'windows-openssh' && distributions.length === 0) {
    const bin = (name) => join(system32, 'OpenSSH', `${name}.exe`)
    const scratch = mkdtempSync(join(tmpdir(), 'dsh ssh probe '))
    try {
      const config = join(scratch, 'config')
      writeFileSync(config, '')
      const version = spawnSync(bin('ssh'), ['-V'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })
      if (version.status !== 0 || !/OpenSSH_for_Windows_/i.test(version.stderr ?? '')) fail('Windows OpenSSH version detection failed')
      const resolved = run(bin('ssh'), ['-F', config, '-G', 'localhost']).toString('utf8')
      if (!/^hostname localhost\r?$/m.test(resolved)) fail('ssh -G did not resolve the test alias')
      const key = join(scratch, 'temporary_key')
      run(bin('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-f', key])
      run(bin('ssh-keygen'), ['-lf', `${key}.pub`])
      console.log('PASS: Windows OpenSSH config and disposable key tooling')
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  } else if (backend === 'wsl' && distributions.length >= 2 && new Set(distributions).size === distributions.length) {
    const wsl = join(system32, 'wsl.exe')
    const bytes = randomBytes(65537)
    for (const distribution of distributions) {
      const args = ['--distribution', distribution, '--exec']
      const version = run(wsl, [...args, 'node', '--version']).toString('utf8').trim()
      run(wsl, [...args, 'ssh', '-V'])
      const result = run(wsl, [...args, 'node', '-e', 'process.stdin.pipe(process.stdout)'], bytes)
      if (!bytes.equals(result)) fail('WSL stdio did not preserve the binary payload')
      console.log(`PASS: ${JSON.stringify(distribution)}: Node ${version}, OpenSSH, binary stdio and EOF`)
    }
  } else {
    fail('usage: node scripts/probe-windows-ssh-initiator.mjs windows-openssh | wsl <first-dist> <second-dist> [more-dist...]')
  }
  return 0
}

try { process.exitCode = main() }
catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exitCode = 1
}
