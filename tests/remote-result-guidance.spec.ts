/**
 * Failure guidance is generated from stable codes and safe fields only — never
 * from a caught exception, SSH diagnostic, or credential path — and candidate
 * lists are filtered by live registration state, direction, actions and the
 * known transfer pairing.
 */
import { describe, expect, it } from 'vitest'
import { parseDeploymentManifest, type DeploymentManifest } from '../src/remote/manifest.ts'
import type { RemoteGrant, RemoteGrantState } from '../src/remote/contract.ts'
import { endpointCandidates, currentEndpointCandidates, localRootCandidates } from '../src/remote/endpoint-candidates.ts'
import {
  argumentFailureGuidance,
  boundText,
  copyFailureGuidance,
  execFailureGuidance,
  execTerminationGuidance,
  execUncertainGuidance,
  type CopyGuidanceContext,
  type ExecGuidanceContext,
} from '../src/remote/result-guidance.ts'
import type { AdditionalRootId } from '../src/roots.ts'

const environment = (environmentId: string) => ({
  environmentId, platform: 'linux', account: 'u', hostKey: `SHA256:${'A'.repeat(43)}`,
  namespace: environmentId, transport: 'sftp', helper: null, connection: { host: `${environmentId}-host` },
  credentialIsolation: 'unattested',
})

function manifestOf(bindings: readonly Record<string, unknown>[]): DeploymentManifest {
  return parseDeploymentManifest(JSON.stringify({
    schemaVersion: 1,
    configVersion: 'cfg-1',
    environments: [environment('build'), environment('device'), environment('prod')],
    bindings,
  }), 'fixture.json').manifest
}

const BINDINGS = [
  {
    primary: '/work/app', environmentId: 'build', rootId: 'app', path: '/srv/build',
    actions: ['read', 'write', 'exec'],
    transfers: [
      { direction: 'export', peer: { environmentId: 'device', rootId: 'out' } },
      { direction: 'export', peer: { environmentId: 'local', rootId: 'primary' } },
      { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
    ],
  },
  {
    primary: '/work/app', environmentId: 'device', rootId: 'out', path: '/srv/out',
    actions: ['read', 'write'],
    transfers: [{ direction: 'import', peer: { environmentId: 'build', rootId: 'app' } }],
  },
  {
    primary: '/work/app', environmentId: 'prod', rootId: 'db', path: '/srv/db',
    actions: ['read'],
    transfers: [],
  },
  {
    primary: '/work/other', environmentId: 'device', rootId: 'out', path: '/srv/out',
    actions: ['read', 'write', 'exec'],
    transfers: [],
  },
]

const manifest = manifestOf(BINDINGS)

function grant(environmentId: string, rootId: string, state: RemoteGrantState): RemoteGrant & { readonly state: RemoteGrantState } {
  return {
    environmentId,
    rootId,
    displayPath: `/srv/${rootId}`,
    verifiedTarget: { kind: 'path', value: `/srv/${rootId}` },
    configVersion: 'cfg-1',
    bindingDigest: 'd'.repeat(64),
    addedAt: '2026-11-23T00:00:00.000Z',
    state,
  }
}

const grants = [
  grant('build', 'app', 'registered'),
  grant('device', 'out', 'registered'),
  grant('prod', 'db', 'withheld'),
]

describe('endpoint candidates', () => {
  it('filters by the session primary, live registration, direction, action and known peer', () => {
    expect(endpointCandidates(manifest, grants, '/work/app', {
      direction: 'source', peer: { environmentId: 'device', rootId: 'out' },
    })).toEqual(['build:app'])
    expect(endpointCandidates(manifest, grants, '/work/app', {
      direction: 'destination', peer: { environmentId: 'build', rootId: 'app' },
    })).toEqual(['device:out'])
    expect(endpointCandidates(manifest, grants, '/work/app', { direction: 'exec' })).toEqual(['build:app'])
    // A project with no binding and the withheld grant are never offered.
    expect(endpointCandidates(manifest, grants, '/work/elsewhere', { direction: 'exec' })).toEqual([])
    expect(endpointCandidates(manifest, grants, '/work/app', { direction: 'source' })).not.toContain('prod:db')
  })

  it('never offers withheld or revoked grants', () => {
    const states = [grant('build', 'app', 'withheld'), grant('device', 'out', 'revoked'), grant('prod', 'db', 'revoked')]
    expect(endpointCandidates(manifest, states, '/work/app', { direction: 'exec' })).toEqual([])
    expect(endpointCandidates(manifest, states, '/work/app', { direction: 'source' })).toEqual([])
    expect(endpointCandidates(manifest, states, '/work/app', { direction: 'destination' })).toEqual([])
  })

  it('requires a reciprocal remote pairing and a registered peer', () => {
    const oneWay = manifestOf([BINDINGS[0]!, { ...BINDINGS[1]!, transfers: [] }])
    const source = { direction: 'source', peer: { environmentId: 'device', rootId: 'out' } } as const
    const destination = { direction: 'destination', peer: { environmentId: 'build', rootId: 'app' } } as const
    expect(endpointCandidates(oneWay, grants, '/work/app', source)).toEqual([])
    expect(endpointCandidates(oneWay, grants, '/work/app', destination)).toEqual([])
    expect(endpointCandidates(manifest, [grants[0]!], '/work/app', source)).toEqual([])
  })

  it('only offers local destinations writable under the current copy policy', () => {
    const destination = { direction: 'destination', peer: { environmentId: 'build', rootId: 'app' } } as const
    const scope = { source: ['primary'], destination: [], remoteDestination: false }
    expect(endpointCandidates(manifest, grants, '/work/app', destination, scope)).toEqual([])
    expect(endpointCandidates(manifest, grants, '/work/app', destination, { ...scope, destination: ['primary'] })).toEqual(['local:primary'])
  })

  it('bounds and sorts the candidates', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      primary: '/work/app', environmentId: 'build', rootId: `root-${index}`, path: `/srv/root-${index}`,
      actions: ['read'], transfers: [],
    }))
    const wide = manifestOf(many)
    const wideGrants = many.map(binding => grant('build', String(binding.rootId), 'registered'))
    const candidates = endpointCandidates(wide, wideGrants, '/work/app', { direction: 'source' })
    expect(candidates).toHaveLength(6)
    expect(candidates).toEqual([...candidates].sort())
  })

  it('returns undefined when the manifest or snapshot is unavailable', async () => {
    const noManifest = {
      async remoteList() { throw new Error('unavailable') },
      get remoteManifest(): DeploymentManifest | undefined { return undefined },
    }
    await expect(currentEndpointCandidates(noManifest, '/work/app', [{ direction: 'source' }])).resolves.toBeUndefined()
    const failing = {
      async remoteList() { throw new Error('ipc down') },
      get remoteManifest(): DeploymentManifest | undefined { return manifest },
    }
    await expect(currentEndpointCandidates(failing, '/work/app', [{ direction: 'source' }])).resolves.toBeUndefined()
  })

  it('gives up on a snapshot that never answers', async () => {
    const hanging = {
      remoteList: () => new Promise<never>(() => {}),
      get remoteManifest(): DeploymentManifest | undefined { return manifest },
    }
    const started = Date.now()
    await expect(currentEndpointCandidates(hanging, '/work/app', [{ direction: 'source' }])).resolves.toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  }, 5_000)

  it('lists primary plus available alias ids for local endpoints', () => {
    const status = (aliasId: unknown, state: 'available' | 'invalid') => ({
      id: 'id-1' as AdditionalRootId, path: '/work/docs', access: 'inherit' as const, addedAt: 't', aliasId, state,
    })
    expect(localRootCandidates({ list: () => [status('docs', 'available'), status('gone', 'invalid')] }, '/work/app'))
      .toEqual(['primary', 'docs'])
    expect(localRootCandidates({ list: () => { throw new Error('unavailable') } }, '/work/app')).toEqual(['primary'])
  })
})

const COPY_CONTEXT: CopyGuidanceContext = {
  from: 'primary:src.txt',
  to: 'build/app:dist/src.txt',
  fromRootId: 'primary',
  toRootId: 'app',
  fromRelativePath: 'src.txt',
  toRelativePath: 'dist/src.txt',
  destinationDisplayPath: '/srv/build',
}

const EXEC_CONTEXT: ExecGuidanceContext = {
  environmentId: 'build',
  rootId: 'app',
  displayPath: '/srv/build',
  cwdRelative: '../escape',
  maxTimeoutMs: 60_000,
}

describe('copy failure guidance', () => {
  it('explains a missing destination parent with the target path and root', () => {
    const text = copyFailureGuidance('destination-parent-missing', 'failed', COPY_CONTEXT)
    expect(text.message).toContain('parent')
    expect(text.message).toContain('/srv/build/dist')
    expect(text.hint).toContain('Create that directory')
  })

  it('explains primary and aliasId spelling for a local root refusal', () => {
    const text = copyFailureGuidance('local-root-unavailable', 'failed', { ...COPY_CONTEXT, localRootIds: ['primary', 'docs'] })
    expect(text.hint).toContain('primary')
    expect(text.hint).toContain('aliasId')
    expect(text.hint).toContain('docs')
  })

  it('names bounded endpoint candidates for endpoint and pairing refusals', () => {
    const text = copyFailureGuidance('endpoint-not-registered', 'failed', {
      ...COPY_CONTEXT, sourceCandidates: ['build:app'], destinationCandidates: ['device:out'],
    })
    expect(text.hint).toContain('build:app')
    expect(text.hint).toContain('device:out')
    expect(text.hint.length).toBeLessThanOrEqual(560)
    const paired = copyFailureGuidance('transfer-pair-not-allowed', 'failed', { ...COPY_CONTEXT, sourceCandidates: [], destinationCandidates: [] })
    expect(paired.hint).toContain('Each remote endpoint must authorize its peer')
  })

  it('preserves uncertainty instead of recommending a blind retry', () => {
    const unknown = copyFailureGuidance('connection-lost', 'unknown', COPY_CONTEXT)
    expect(unknown.message).toContain('unknown')
    expect(unknown.hint).toContain('reconcileId')
    expect(unknown.hint.toLowerCase()).toContain('do not retry blindly')
    expect(copyFailureGuidance(undefined, 'partial', COPY_CONTEXT).hint).toContain('staging')
  })

  it('never echoes a caught exception: the text depends on the stable code only', () => {
    const a = copyFailureGuidance('source-open-failed', 'failed', COPY_CONTEXT)
    const b = copyFailureGuidance('source-open-failed', 'failed', COPY_CONTEXT)
    expect(a).toEqual(b)
    expect(a.message).not.toContain('Error:')
    expect(a.hint).not.toContain('/home/')
  })

  it('falls back to a bounded generic message for an unknown stable code', () => {
    const text = copyFailureGuidance('something-new', 'failed', COPY_CONTEXT)
    expect(text.message).toContain('something-new')
    expect(text.hint).toContain('retry')
    expect(text.message.length).toBeLessThanOrEqual(240)
  })
})

describe('exec failure guidance', () => {
  it('includes the admitted display path and the empty-cwd rule', () => {
    const text = execFailureGuidance('invalid-cwd', EXEC_CONTEXT)
    expect(text.hint).toContain('/srv/build')
    expect(text.hint).toContain('""')
    expect(text.hint).toContain('normalized relative POSIX path')
  })

  it('states the accepted timeout range', () => {
    expect(execFailureGuidance('invalid-timeout', EXEC_CONTEXT).hint).toContain('60000')
  })

  it('lists registered exec candidates when the snapshot provided them', () => {
    expect(execFailureGuidance('action-not-allowed', { ...EXEC_CONTEXT, candidates: ['build:app'] }).hint).toContain('build:app')
  })

  it('keeps unknown and admitted-may-start uncertain', () => {
    for (const status of ['unknown', 'admitted-may-start'] as const) {
      const text = execUncertainGuidance(status)
      expect(text.hint).toContain('Confirm on the remote host')
      expect(text.hint).toContain('do not retry blindly')
    }
  })

  it('names each termination cause', () => {
    expect(execTerminationGuidance('timeout', true).message).toContain('timeoutMs')
    expect(execTerminationGuidance('cancelled', true).message).toContain('cancelled')
    expect(execTerminationGuidance('revoked', true).message).toContain('grant')
  })

  it.each(['timeout', 'cancelled', 'revoked'] as const)('preserves an unconfirmed scope after %s', cause => {
    const text = execTerminationGuidance(cause, false)
    expect(text.message).toContain('scope is unconfirmed')
    expect(text.hint).toContain('Descendants may still be running')
    expect(text.hint).toContain('before starting another command')
  })
})

describe('argument guidance', () => {
  it('locates the offending fields and stays bounded', () => {
    const text = argumentFailureGuidance('remote_copy', [
      { path: 'from.relativePath', detail: 'is required' },
      { path: 'to.extra', detail: 'is not an accepted field' },
    ])
    expect(text.message).toContain('"from.relativePath" is required')
    expect(text.message).toContain('"to.extra" is not an accepted field')
    expect(text.hint).toContain('environmentId')
  })

  it('bounds generated text', () => {
    expect(boundText('x'.repeat(100), 10)).toHaveLength(10)
    expect(boundText('short', 10)).toBe('short')
  })
})
