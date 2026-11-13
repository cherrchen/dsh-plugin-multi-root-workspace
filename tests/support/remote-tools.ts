/**
 * The dedicated headless composition for G5: the real registry, sessions,
 * policy, prompt and tool pipeline, the explicit remote tools row, and one
 * in-memory deployment (build machine + device). No profile row mounts any of
 * this — the composition exists only under tests, which is what keeps the
 * remote experiment default-off in every shipped profile.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as CommandModule from '../../src/command.ts'
import { mountRemoteTools as registerTools } from '../../src/remote/tools-registration.ts'
import type { RemoteExecDeployment } from '../../src/remote/exec.ts'
import { mountRegistryStack, type RegistryStack } from './registry-stack.ts'
import { executeTool, installToolExecutor } from './tool-executor.ts'
import { FakeManager, FakeRemote, fakeExecBackend, fakeManifest, FAKE_EXEC } from './fake-remote.ts'
import type { FixtureWorkspace } from './temp-workspace.ts'

/** One mounted remote-tools world. */
export interface RemoteToolsWorld {
  readonly stack: RegistryStack
  readonly ctx: Context
  readonly session: ReturnType<Context['sessions']['create']>
  readonly agent: Agent
  readonly remotes: ReadonlyMap<string, FakeRemote>
  readonly manager: FakeManager
  call(name: 'remote_copy' | 'remote_bash', args: unknown, options?: { agent?: Agent; signal?: AbortSignal }): Promise<unknown>
  /** Call one panel endpoint through the registered channel handler. */
  panel(endpoint: string, payload: unknown): Promise<PanelAnswer>
  unmountTools(): Promise<void>
  dispose(): Promise<void>
}

/** A channel answer, as the host's RPC envelope carries it. */
export interface PanelAnswer {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

export interface RemoteToolsWorldOptions {
  /** Local root ids the deployment authorizes as copy peers; default `['primary']`. */
  readonly localRootIds?: readonly string[]
  /** Add a device exec block so a device-capable deployment can be exercised. */
  readonly deviceExec?: boolean
  /** Device binding actions; default `['read','write']`. */
  readonly deviceActions?: readonly ('read' | 'write' | 'exec')[]
  /** Mount the explicit-tools row; `false` leaves the composition tool-less. */
  readonly withTools?: boolean
  /** Exercise the row's own default SSH-adapter factory instead of injected backends. */
  readonly defaultBackends?: boolean
  /** Mount the command/panel row over a stub Connection; `panel()` then works. */
  readonly withPanel?: boolean
  /**
   * The registry's `remoteEnvironments` overlay. Default `{ enabled: true }`;
   * `{}` ships `manifestPath` WITHOUT `enabled` (the default-bundle shape, so
   * the live switch owns the plane), `{ enabled: false }` sets it explicitly.
   */
  readonly remote?: { readonly enabled?: boolean }
  /** Per-environment extra files, keyed by environment and absolute path. */
  readonly seed?: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>
}

function manifestFile(fixture: FixtureWorkspace, options: RemoteToolsWorldOptions): string {
  const manifest = fakeManifest({
    primary: fixture.workspace,
    localRootIds: options.localRootIds ?? ['primary'],
    ...(options.deviceActions === undefined ? {} : { deviceActions: options.deviceActions }),
  })
  if (options.deviceExec === true) {
    const device = manifest.environments.find(environment => environment.environmentId === 'device')!
    ;(device as { transport: string }).transport = 'helper'
    ;(device as { helper: unknown }).helper = { sha256: 'd'.repeat(64), protocol: 1 }
    ;(device as { connection: unknown }).connection = { host: 'device-host', nodePath: '/opt/node', helperPath: '/opt/helper.js', workspace: '/srv/root' }
    ;(device as { exec?: RemoteExecDeployment }).exec = FAKE_EXEC
  }
  const path = join(fixture.base, 'deploy-g5.json')
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
  return path
}

/**
 * Mount one headless composition.
 * @param fixture - the fixture workspace (its `base` holds the store and manifest).
 * @param options - deployment shape and seeding.
 */
export async function mountRemoteTools(fixture: FixtureWorkspace, options: RemoteToolsWorldOptions = {}): Promise<RemoteToolsWorld> {
  const manifestPath = manifestFile(fixture, options)
  const remotes = new Map<string, FakeRemote>([
    ['build', new FakeRemote('build')],
    ['device', new FakeRemote('device')],
  ])
  for (const environmentId of ['build', 'device']) {
    const remote = remotes.get(environmentId)!
    remote.directory('/srv/root')
    remote.directory('/srv/root/src')
    remote.directory('/srv/root/dist')
  }
  // Same path, different content per environment: the device already carries
  // different bytes at the same names, so a copy can never satisfy the wrong side.
  remotes.get('device')!.seed('/srv/root/src/a.txt', 'device-only content\n')
  for (const [environmentId, files] of Object.entries(options.seed ?? {})) {
    for (const [path, content] of Object.entries(files ?? {})) remotes.get(environmentId)?.seed(path, content)
  }
  const backends = new Map([['build', fakeExecBackend(remotes.get('build')!, FAKE_EXEC)]])
  if (options.deviceExec === true) backends.set('device', fakeExecBackend(remotes.get('device')!, FAKE_EXEC))

  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: { ...(options.remote ?? { enabled: true }), manifestPath },
  }, {
    allowUserOwnedRemoteManifestForTesting: true,
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  await stack.ctx.plugin(SystemPrompt)
  await stack.ctx.plugin(Tools)
  stack.ctx.provide('permissionPresets', { names: [] } as never)
  if (stack.ctx.get('sandbox') === undefined) {
    stack.ctx.provide('sandbox', { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) } as never)
  } else if (typeof stack.ctx.sandbox.confine !== 'function') {
    Object.assign(stack.ctx.sandbox, { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) })
  }
  if (stack.ctx.get('subprocess') === undefined) {
    stack.ctx.provide('subprocess', {
      spawn: () => { throw new Error('remote-tools fixture has no subprocess.spawn') },
      spawnTerminal: () => { throw new Error('remote-tools fixture has no subprocess.spawnTerminal') },
    } as never)
  }
  await installToolExecutor(stack.ctx)
  const manager = new FakeManager(stack.registry.remoteManifest!, remotes, backends)
  const tools = options.withTools === false ? undefined : await stack.ctx.plugin({
    name: 'g5-remote-tools',
    inject: ['multiRootRegistry', 'multiRootCompat', 'multiRootProviders', 'tools'],
    apply: (ctx: Context) => registerTools(ctx, manager, options.defaultBackends === true ? undefined : id => backends.get(id)),
  })
  let panelHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<PanelAnswer>) | undefined
  if (options.withPanel === true) {
    stack.ctx.provide('commands', { register: () => () => {} } as never)
    stack.ctx.provide('webServer', {} as never)
    stack.ctx.provide('connection', {
      rpc: {
        handle: (_channel: string, registered: NonNullable<typeof panelHandler>) => {
          panelHandler = registered
          return async () => {}
        },
      },
    } as never)
    await stack.ctx.plugin(CommandModule, {})
  }
  const session = stack.ctx.sessions.create(SessionId(`g5-${fixture.base.split('/').pop()}`), { meta: { cwd: fixture.workspace } })
  const agent = { id: session.id, session } as Agent
  let sequence = 0
  return {
    stack, ctx: stack.ctx, session, agent, remotes, manager,
    call: async (name, args, callOptions = {}) => {
      const outcome = await executeTool(stack.ctx, {
        callId: `g5-${++sequence}`, name, args,
        agent: callOptions.agent ?? agent,
        signal: callOptions.signal ?? new AbortController().signal,
      }) as { isError: boolean; value?: unknown }
      // A failure keeps its full outcome (the tests assert the refusal); a
      // success unwraps to the tool's canonical value.
      return outcome.isError ? outcome : outcome.value
    },
    panel: async (endpoint, payload) => {
      if (panelHandler === undefined) throw new Error('the composition mounted no panel channel')
      return await panelHandler(endpoint, payload, new AbortController().signal)
    },
    unmountTools: async () => { await tools?.dispose() },
    dispose: async () => { await stack.dispose() },
  }
}

/** Register one additional local root and give it the deployment's peer id. */
export async function registerLocalPeer(world: RemoteToolsWorld, path: string, aliasId: string): Promise<string> {
  const primary = world.session.header.cwd!
  const statuses = await world.stack.registry.add(primary, { path })
  const status = statuses.find(entry => entry.path === path) ?? statuses[statuses.length - 1]!
  const ordinal = statuses.indexOf(status) + 1
  await world.stack.registry.setAliasId(primary, { kind: 'entry', ordinal, id: status.id, path: status.path, addedAt: status.addedAt }, aliasId)
  return aliasId
}

/** Register one remote endpoint through the real verifier + owner commit. */
export async function registerRemote(world: RemoteToolsWorld, environmentId: string, rootId: string): Promise<void> {
  await world.stack.registry.addRemote(world.session.header.cwd!, { environmentId, rootId })
}
