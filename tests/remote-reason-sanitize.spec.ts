import { describe, expect, it } from 'vitest'
import { renderRemoteCapabilities } from '../src/remote/capabilities.ts'
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

describe('renderRemoteCapabilities reason injection', () => {
  it('renders the structured state without copying arbitrary host diagnostics', () => {
    const reason = String.raw`could not read /srv/private path or C:\private\store or \\host\share`
    const text = renderRemoteCapabilities({
      bindings: [BINDING], environments: [ENV], mode: 'workspace-write',
      status: { state: 'config-invalid', reason },
    })
    expect(text).toContain('The remote control plane is config-invalid')
    expect(text).not.toContain('private')
    expect(text).not.toContain('host\\share')
    expect(text).toContain('/srv/app')
  })

  it('a ready plane injects no reason text', () => {
    const text = renderRemoteCapabilities({
      bindings: [BINDING], environments: [ENV], mode: 'workspace-write',
      status: { state: 'ready' },
    })
    expect(text).not.toContain('refused with remote-unavailable')
  })
})
