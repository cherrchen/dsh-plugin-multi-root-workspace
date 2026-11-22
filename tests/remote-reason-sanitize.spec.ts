/**
 * `status.reason` reaches the model through the `multi-root-remote-tools`
 * runtime-context row. Before injection it is sanitized: the user's home
 * directory becomes `~`, whitespace collapses, and the text is bounded.
 */
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { renderRemoteCapabilities, sanitizeRemoteReason } from '../src/remote/capabilities.ts'
import type { RemoteEnvironment } from '../src/remote/manifest.ts'

const ENV: RemoteEnvironment = {
  environmentId: 'dev-box', platform: 'linux', account: 'builder',
  hostKey: 'SHA256:' + 'A'.repeat(43), namespace: 'dev-box',
  transport: 'sftp', helper: null,
  connection: { host: 'dsh-dev-box' },
  credentialIsolation: 'unattested',
  personalIdentity: { hostname: 'build.internal', port: 22, credentialDigest: 'a'.repeat(64) },
}

const BINDING = { primary: '/w', environmentId: 'dev-box', rootId: 'app', path: '/srv/app', actions: ['read' as const] }

describe('sanitizeRemoteReason', () => {
  it('hides the home directory, collapses whitespace, and bounds the length', () => {
    const reason = `cannot read ${homedir()}/.dsh/remote-personal.json:\n  lstat failed   badly\n${'x'.repeat(300)}`
    const clean = sanitizeRemoteReason(reason)
    expect(clean).not.toContain(homedir())
    expect(clean.startsWith('cannot read ~/.dsh/remote-personal.json: lstat failed badly')).toBe(true)
    expect(clean).not.toContain('\n')
    expect(clean.length).toBeLessThanOrEqual(200)
    expect(clean.endsWith('…')).toBe(true)
  })

  it('a short reason passes through with whitespace collapsed', () => {
    expect(sanitizeRemoteReason('the file  changed\nmid-read')).toBe('the file changed mid-read')
  })
})

describe('renderRemoteCapabilities reason injection', () => {
  it('injects the sanitized reason, never the raw home path', () => {
    const home = homedir()
    const reason = `config-invalid: ${home}/.dsh/remote-personal.json not group/other-accessible`
    const text = renderRemoteCapabilities({
      bindings: [BINDING], environments: [ENV], mode: 'workspace-write',
      status: { state: 'config-invalid', reason },
    })
    expect(text).toContain(`(${sanitizeRemoteReason(reason)})`)
    expect(text).not.toContain(`${home}/.dsh`)
    expect(text).toContain('~/.dsh/remote-personal.json')
  })

  it('a ready plane injects no reason text', () => {
    const text = renderRemoteCapabilities({
      bindings: [BINDING], environments: [ENV], mode: 'workspace-write',
      status: { state: 'ready' },
    })
    expect(text).not.toContain('refused with remote-unavailable')
  })
})
