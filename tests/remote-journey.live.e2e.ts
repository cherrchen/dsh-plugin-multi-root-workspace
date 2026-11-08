/**
 * G5's single-Session journey on the REAL broker deployment: two local roots
 * → build machine (`vps-app`, helper + exec) → device (`vps-xfer`, SFTP only).
 * Gated on DSH_MULTI_ROOT_BROKER_LIVE — the same broker-live.json as
 * remote-broker.live.e2e.ts — and mounts the production `broker:` path of
 * applyRemoteTools, so attestation, the endpoint verifier, both tool
 * registrations, and the capability projection all take the shipped route.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { REMOTE_CONTEXT_NAME } from '../src/remote/capabilities.ts'
import { loadDeploymentManifest } from '../src/remote/manifest.ts'
import { apply as applyRemoteTools } from '../src/remote/tools.ts'
import { attestBroker, type BrokerConfig } from '../src/remote/broker/attest.ts'
import * as CommandModule from '../src/command.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { executeTool, installToolExecutor } from './support/tool-executor.ts'

const LIVE = process.env.DSH_MULTI_ROOT_BROKER_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  socketPath: string; brokerUid: number; credentialRoot: string; manifestPath: string
  confinementProbe: { verified: boolean; evidence?: string }
  primary: string; outsideSentinel: string; workspaceApp: string; workspaceLib: string
}
const brokerConfig: BrokerConfig = LIVE === undefined ? {} as never : {
  socketPath: live.socketPath,
  brokerUid: live.brokerUid,
  credentialRoot: live.credentialRoot,
  confinementProbe: live.confinementProbe,
}

const SOURCE_A = 'source from the primary repository\n'
const SOURCE_B = 'source from the additional repository\n'
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

interface ToolResult { readonly status?: string; readonly code?: string; readonly bytes?: number; readonly sha256?: string; readonly exitCode?: number | null; readonly stdout?: string; readonly scope?: string; readonly isError?: boolean }
type PanelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }>

const stacks: RegistryStack[] = []
const tmpdirs: string[] = []
afterEach(async () => {
  for (const stack of stacks.reverse()) await stack.dispose()
  stacks.length = 0
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const name of ['src/a.txt', 'downloads/app.tar']) rmSync(join(live.primary, name), { force: true })
})

/** A second attested connection, used only to remove files the journey created. */
async function purgeRemote(environmentId: string, names: readonly string[]) {
  const attestation = await attestBroker(brokerConfig, loadDeploymentManifest(live.manifestPath).manifest)
  if (attestation.status !== 'attested') return
  try {
    const env = await attestation.manager.openSftp(environmentId).catch(() => undefined)
    for (const name of names) await env?.client.remove(`/import/${name}`).catch(() => {})
  } finally {
    await attestation.manager.disposeAll().catch(() => {})
  }
}

async function mount(withPanel = false) {
  const base = mkdtempSync(join(tmpdir(), 'g5-live-'))
  tmpdirs.push(base)
  const stack = await mountRegistryStack(join(base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: live.manifestPath },
  }, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections); await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: live.primary })
    },
  })
  stacks.push(stack)
  await stack.ctx.plugin(SystemPrompt)
  await stack.ctx.plugin(Tools)
  await installToolExecutor(stack.ctx)
  // The production wiring: attest first, then mount both tools, the endpoint
  // verifier and the capability projection — nothing in-process holds a key.
  await stack.ctx.plugin({
    name: 'g5-live-remote-tools',
    inject: ['multiRootRegistry', 'multiRootCompat', 'multiRootProviders', 'tools'],
    apply: (ctx: Context) => applyRemoteTools(ctx, { broker: { config: brokerConfig } }),
  })
  let panelHandler: PanelHandler | undefined
  if (withPanel) {
    stack.ctx.provide('commands', { register: () => () => {} } as never)
    stack.ctx.provide('webServer', {} as never)
    stack.ctx.provide('connection', {
      rpc: { handle: (_channel: string, registered: PanelHandler) => { panelHandler = registered; return async () => {} } },
    } as never)
    await stack.ctx.plugin(CommandModule, {})
  }

  const session = stack.ctx.sessions.create(SessionId(`g5-live-${Date.now()}`), { meta: { cwd: live.primary } })
  const agent = { id: session.id, session } as Agent
  let sequence = 0
  const call = async (name: 'remote_copy' | 'remote_bash', args: unknown, options: { agent?: Agent; signal?: AbortSignal } = {}): Promise<ToolResult> => {
    const outcome = await executeTool(stack.ctx, {
      callId: `g5-live-${++sequence}`, name, args,
      agent: options.agent ?? agent,
      signal: options.signal ?? new AbortController().signal,
    }) as { isError: boolean; value?: unknown }
    return (outcome.isError ? outcome : outcome.value) as ToolResult
  }
  // Attestation is asynchronous: poll the real tool registry until the broker
  // manager mounts both tools.
  const tools = stack.ctx.tools as { get(name: string): unknown }
  const deadline = Date.now() + 60_000
  while (tools.get('remote_copy') === undefined || tools.get('remote_bash') === undefined) {
    if (Date.now() > deadline) throw new Error('remote tools never mounted within 60s')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { stack, session, agent, call, panel: (endpoint: string, payload: unknown) => {
    if (panelHandler === undefined) throw new Error('no panel channel')
    return panelHandler(endpoint, payload, new AbortController().signal)
  } }
}

liveDescribe('the real journey over broker custody', () => {
  it('two local roots → build machine → device, then device exec refusal', async () => {
    const world = await mount()
    const { stack } = world
    const repoB = mkdtempSync(join(tmpdir(), 'g5-live-repob-'))
    tmpdirs.push(repoB)
    mkdirSync(join(live.primary, 'src'), { recursive: true })
    writeFileSync(join(live.primary, 'src/a.txt'), SOURCE_A)
    mkdirSync(join(repoB, 'src'), { recursive: true })
    writeFileSync(join(repoB, 'src/b.txt'), SOURCE_B)
    const statuses = await stack.registry.add(live.primary, { path: repoB })
    await stack.registry.setAliasId(live.primary, { kind: 'id', id: statuses[0]!.id }, 'xlib')
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    try {
      const dirs = await world.call('remote_bash', {
        environmentId: 'vps-app', rootId: 'app', command: 'mkdir -p src dist', timeoutMs: 10_000,
      })
      expect(dirs, JSON.stringify(dirs)).toMatchObject({ status: 'scope-exited', exitCode: 0 })
      const seeded = await world.call('remote_copy', {
        from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
        to: { environmentId: 'vps-app', rootId: 'app', relativePath: 'src/a.txt' },
      })
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ status: 'committed', bytes: Buffer.byteLength(SOURCE_A) })
      const seededB = await world.call('remote_copy', {
        from: { environmentId: 'local', rootId: 'xlib', relativePath: 'src/b.txt' },
        to: { environmentId: 'vps-app', rootId: 'app', relativePath: 'src/b.txt' },
      })
      expect(seededB, JSON.stringify(seededB)).toMatchObject({ status: 'committed', bytes: Buffer.byteLength(SOURCE_B) })

      const built = await world.call('remote_bash', {
        environmentId: 'vps-app', rootId: 'app', timeoutMs: 15_000,
        command: 'mkdir -p src dist && cat src/a.txt > dist/app.tar && printf -- "--\\n" >> dist/app.tar && cat src/b.txt >> dist/app.tar && echo "built app"',
      })
      expect(built, JSON.stringify(built)).toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 0 })
      expect(built.stdout).toContain('built app')

      const artifact = Buffer.concat([Buffer.from(SOURCE_A), Buffer.from('--\n'), Buffer.from(SOURCE_B)])
      const relayed = await world.call('remote_copy', {
        from: { environmentId: 'vps-app', rootId: 'app', relativePath: 'dist/app.tar' },
        to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'journey-app.tar' },
      })
      expect(relayed, JSON.stringify(relayed)).toMatchObject({ status: 'committed', bytes: artifact.length, sha256: sha(artifact) })

      const downloaded = await world.call('remote_copy', {
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'journey-app.tar' },
        to: { environmentId: 'local', rootId: 'primary', relativePath: 'downloads/app.tar' },
      })
      expect(downloaded, JSON.stringify(downloaded)).toMatchObject({ status: 'committed' })
      expect(readFileSync(join(live.primary, 'downloads/app.tar')).equals(artifact)).toBe(true)

      // The device is transfer-only: execution refuses before any backend call.
      const refused = await world.call('remote_bash', {
        environmentId: 'vps-xfer', rootId: 'import', command: 'true', timeoutMs: 5_000,
      })
      expect(refused).toMatchObject({ status: 'not-started', code: 'action-not-allowed' })
    } finally {
      await world.call('remote_bash', { environmentId: 'vps-app', rootId: 'app', command: 'rm -rf src dist', timeoutMs: 10_000 }).catch(() => {})
      await purgeRemote('vps-xfer', ['journey-app.tar'])
    }
  }, 300_000)

  it('refuses a read-only session every remote write, transfer destination, and command', async () => {
    const world = await mount()
    const { stack } = world
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    const reader = stack.ctx.sessions.create(SessionId('g5-live-reader'), { meta: { cwd: live.primary } })
    reader.append('sandbox/mode', { mode: 'read-only' })
    const agent = { id: reader.id, session: reader } as Agent
    const denied = await world.call('remote_bash', {
      environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 5_000,
    }, { agent })
    expect(denied).toMatchObject({ status: 'not-started', code: 'mode-denies' })
    const upload = await world.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'vps-app', rootId: 'app', relativePath: 'ro-upload.txt' },
    }, { agent })
    expect(upload).toMatchObject({ status: 'failed', code: 'mode-denies' })
    const download = await world.call('remote_copy', {
      from: { environmentId: 'vps-app', rootId: 'app', relativePath: 'dist/app.tar' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'downloads/ro.tar' },
    }, { agent })
    expect(download).toMatchObject({ status: 'failed', code: 'mode-denies' })
  }, 120_000)

  it('refuses an unregistered, revoked, and undeclared endpoint and a local-only copy', async () => {
    const world = await mount()
    const { stack } = world
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    await stack.registry.removeRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    const revoked = await world.call('remote_copy', {
      from: { environmentId: 'vps-app', rootId: 'app', relativePath: 'dist/app.tar' },
      to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'revoked.tar' },
    })
    expect(revoked).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    const unknown = await world.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'staging', rootId: 'app', relativePath: 'a.txt' },
    })
    expect(unknown).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    const localToLocal = await world.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'copy.txt' },
    })
    expect(localToLocal).toMatchObject({ status: 'failed', code: 'direction-unsupported' })
  }, 120_000)

  it('projects the deployment to the model without credentials or alias names', async () => {
    const world = await mount(true)
    const { stack } = world
    await stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    const assembly = await stack.ctx.systemPrompt.assemble({ agent: world.agent })
    const text = assembly.contexts.find(context => context.name === REMOTE_CONTEXT_NAME)?.text ?? ''
    expect(text).toContain('vps-app')
    expect(text).toContain('vps-xfer')
    for (const secret of ['vps-build', 'dshbuild', 'dshxfer', '_dsh_ssh', 'id_ed25519']) {
      expect(text).not.toContain(secret)
    }
    const listed = await world.panel('remotes', { sessionId: world.session.id })
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    const missing = await world.panel('remotes', { sessionId: 'no-such-session' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  }, 120_000)
})
