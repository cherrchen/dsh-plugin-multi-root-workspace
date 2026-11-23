/**
 * Child-process regression for the forwarded-stream event escape.
 *
 * Node's default fatal behaviour is kept: the control child installs no guard
 * and exits nonzero on the late 'error'; the fixed child installs the plugin
 * guard before the authentication listener is removed and exits normally.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'compat', 'ssh-stream-ciphers.ts')).href

function childSource(guard: boolean): string {
  return `import { EventEmitter } from 'node:events'
import { installClientPskFallback, UPSTREAM_PSK_CIPHER } from ${JSON.stringify(moduleUrl)}
const stream = new EventEmitter()
const options = {
  ciphers: UPSTREAM_PSK_CIPHER, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  rejectUnauthorized: true, pskCallback: () => ({ psk: Buffer.alloc(32), identity: 'dsh-stream' }),
  checkServerIdentity: () => undefined, socket: {},
}
const tls = { getCiphers: () => [UPSTREAM_PSK_CIPHER], connect: () => stream }
${guard ? 'installClientPskFallback({ tls, sync: () => {} })' : ''}
const socket = tls.connect(options)
const failed = () => {}
socket.on('error', failed)
// Upstream authenticateStream removes its one-shot handler on secureConnect
// and only then returns; SshConnection attaches the permanent handler after
// that return. A close in this gap used to be an unhandled 'error'.
socket.emit('secureConnect')
socket.off('error', failed)
socket.emit('error', new Error('SSH connection lost; remote operation outcome and cleanup are unknown'))
process.stdout.write('survived\\n')
`
}

function run(source: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mrfw-race-'))
  const path = join(dir, 'child.mjs')
  writeFileSync(path, source)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', path], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      rmSync(dir, { recursive: true, force: true })
      resolve({ code, stdout, stderr })
    })
  })
}

describe('forwarded-stream late error', () => {
  it('keeps Node fatal without the guard and survives with it', async () => {
    const control = await run(childSource(false))
    expect(control.code, control.stderr).not.toBe(0)
    expect(control.stderr).toContain('SSH connection lost')
    const fixed = await run(childSource(true))
    expect(fixed.code, fixed.stderr).toBe(0)
    expect(fixed.stdout).toContain('survived')
    expect(fixed.stderr).not.toContain('Unhandled')
  }, 30_000)
})
