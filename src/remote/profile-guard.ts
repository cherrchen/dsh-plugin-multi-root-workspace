import type { Context } from '@deepseek-ai/cordis'
import { wrapMethod } from '../method-wrapper.ts'
import { confineInstalled } from '../compat/sandbox-confine.ts'
import { hasConfinedProfile, originalProcessArgv } from '../compat/process-profile.ts'
import { withRegistryAdmission } from '../registry-operation.ts'

export class RemoteProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RemoteProfileError'
  }
}

const ESCALATION_PREFIX = 'escalate sandbox to danger-full-access: '
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 256
const ENV_PREFIXES = ['LD_', 'DYLD_']
const ENV_KEYS = ['NODE_OPTIONS', 'NODE_PATH']

interface SpawnSpec {
  readonly argv?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

const serializeArgv = (argv: readonly string[]): string => JSON.stringify([...argv])
const now = (): number => performance.now()

function checkEnv(env: Readonly<Record<string, string | undefined>> | undefined): void {
  if (env === undefined) return
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== ''
      && (ENV_KEYS.includes(key) || ENV_PREFIXES.some(prefix => key.startsWith(prefix)))) {
      throw new RemoteProfileError('remote-profile-env-injection', `the remote profile refuses spec.env.${key}`)
    }
  }
}

function purge(ledger: Map<string, number[]>): void {
  const at = now()
  for (const [key, entries] of ledger) {
    const live = entries.filter(expiresAt => expiresAt > at)
    if (live.length === 0) ledger.delete(key)
    else ledger.set(key, live)
  }
}

function mint(ledger: Map<string, number[]>, argv: readonly string[]): void {
  purge(ledger)
  const size = [...ledger.values()].reduce((sum, entries) => sum + entries.length, 0)
  if (size >= MAX_TICKETS) throw new RemoteProfileError('remote-profile-ledger-full', 'the remote profile confinement ledger is full')
  const key = serializeArgv(argv)
  const entries = ledger.get(key) ?? []
  entries.push(now() + TICKET_TTL_MS)
  ledger.set(key, entries)
}

function consume(ledger: Map<string, number[]>, argv: readonly string[]): void {
  const key = serializeArgv(argv)
  const entries = ledger.get(key)
  const expiry = entries?.shift()
  if (entries !== undefined && entries.length === 0) ledger.delete(key)
  if (expiry === undefined) {
    purge(ledger)
    throw new RemoteProfileError('remote-profile-unconfined-spawn', 'subprocess.spawn requires a live confined argv minted by this profile')
  }
  if (expiry <= now()) {
    throw new RemoteProfileError('remote-profile-ticket-expired', 'the confinement ticket expired')
  }
}

const maybeAsync = <T>(value: T | Promise<T>, check: (resolved: T) => T): T | Promise<T> =>
  value instanceof Promise ? value.then(check) : check(value)

export function installRemoteProfileGuard(ctx: Context): () => void {
  const ledger = new Map<string, number[]>()
  const restores: Array<() => void> = []
  let disposed = false

  const requireService = <T>(name: string): T => {
    const service = ctx.get(name) as T | undefined
    if (service === undefined) {
      throw new RemoteProfileError('remote-profile-unavailable', `the remote profile requires the "${name}" service`)
    }
    return service
  }

  try {
    const policy = requireService<{ resolve?: unknown }>('sandboxPolicy')
    if (typeof policy.resolve !== 'function') {
      throw new RemoteProfileError('remote-profile-unavailable', 'the sandboxPolicy.resolve seam is missing')
    }
    const sandbox = requireService<{ confine?: unknown }>('sandbox')
    if (typeof sandbox.confine !== 'function') {
      throw new RemoteProfileError('remote-profile-unavailable', 'the sandbox.confine seam is missing')
    }
    const subprocess = requireService<{ spawn?: unknown; spawnTerminal?: unknown }>('subprocess')
    if (typeof subprocess.spawn !== 'function' || typeof subprocess.spawnTerminal !== 'function') {
      throw new RemoteProfileError('remote-profile-unavailable', 'the subprocess spawn seams are missing')
    }
    const sessions = requireService<{ get(id: string): unknown }>('sessions')

    restores.push(wrapMethod(policy, 'resolve', original => function (this: unknown, ...args: unknown[]) {
      const resolved = (original as (...a: unknown[]) => unknown).apply(this, args)
      return maybeAsync(resolved as { mode?: string } | Promise<{ mode?: string }>, result => {
        if (result.mode === 'danger-full-access') {
          throw new RemoteProfileError('remote-profile-full-access', 'this profile never resolves danger-full-access')
        }
        return result
      }) as never
    }))

    restores.push(wrapMethod(sandbox, 'confine', original => function (this: unknown, argv: readonly string[], confinePolicy: { mode?: string }, signal?: AbortSignal) {
      if (disposed) throw new RemoteProfileError('remote-profile-disposed', 'the remote profile guard is disposed')
      if (confinePolicy?.mode === 'danger-full-access') {
        throw new RemoteProfileError('remote-profile-full-access', 'this profile refuses a danger-full-access confine')
      }
      const result = (original as (...a: unknown[]) => unknown).call(this, argv, confinePolicy, signal)
      return maybeAsync(result as { argv: readonly string[]; enforcement?: string } | Promise<{ argv: readonly string[]; enforcement?: string }>, confined => {
        if (disposed) throw new RemoteProfileError('remote-profile-disposed', 'the remote profile guard is disposed')
        if (confined.enforcement === 'full' && hasConfinedProfile(confined.argv)) mint(ledger, confined.argv)
        return confined
      }) as never
    }))

    restores.push(wrapMethod(subprocess, 'spawn', original => function (this: unknown, spec: SpawnSpec) {
      checkEnv(spec.env)
      const argv = spec.argv
      if (argv === undefined || argv.length === 0 || !hasConfinedProfile(argv)) {
        throw new RemoteProfileError('remote-profile-unconfined-spawn', 'subprocess.spawn requires a live confined argv minted by this profile')
      }
      consume(ledger, argv)
      return (original as (...a: unknown[]) => unknown).call(this, spec)
    }))

    restores.push(wrapMethod(subprocess, 'spawnTerminal', original => async function (this: unknown, spec: SpawnSpec) {
      if (spec.env?.DSH_PTY_SESSION_ID === undefined) {
        return await (original as (...a: unknown[]) => unknown).call(this, spec)
      }
      checkEnv(spec.env)
      const sessionId = spec.env?.DSH_SESSION_ID
      const session = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (session === undefined || session === null) {
        throw new RemoteProfileError('remote-profile-terminal-session', 'the Agent terminal marker names no live session')
      }
      const argv = spec.argv
      if (argv === undefined || argv.length === 0) {
        throw new RemoteProfileError('remote-profile-terminal-argv', 'the Agent terminal requires a nonempty argv')
      }
      const resolved = (policy as { resolve(input: unknown): unknown }).resolve({ session })
      const terminalPolicy = await (resolved instanceof Promise ? resolved : Promise.resolve(resolved)) as { mode?: string }
      if (terminalPolicy.mode === 'danger-full-access') {
        throw new RemoteProfileError('remote-profile-full-access', 'this profile never runs an Agent terminal under danger-full-access')
      }
      const confine = async (): Promise<SpawnSpec> => {
        const confined = await confineInstalled(sandbox as never, originalProcessArgv(argv), terminalPolicy as never, spec.signal) as { argv: readonly string[]; enforcement?: string }
        if (confined.enforcement !== 'full' || !hasConfinedProfile(confined.argv)) {
          throw new RemoteProfileError('remote-profile-unconfined-spawn', 'the Agent terminal confine did not produce a fully enforced argv')
        }
        consume(ledger, confined.argv)
        return { ...spec, argv: confined.argv }
      }
      const shared = (ctx.get('multiRootRegistry') as { shared?: boolean } | undefined)?.shared === true
      const next = shared ? await withRegistryAdmission(ctx, terminalPolicy as never, 'pty', confine) : await confine()
      return await (original as (...a: unknown[]) => unknown).call(this, next)
    }))

    const approvalFiber = ctx.inject(['approval'], scoped => {
      const approval = scoped.get('approval') as unknown as { request?: (input: { reason?: string }) => unknown } | undefined
      if (typeof approval?.request !== 'function') return
      const restore = wrapMethod(approval, 'request', original => function (this: unknown, input: { reason?: string }) {
        if (input?.reason?.startsWith(ESCALATION_PREFIX)) return Promise.resolve('rejected')
        return (original as (...a: unknown[]) => unknown).call(this, input)
      })
      restores.push(restore)
      scoped.effect(() => restore)
    })
    restores.push(() => { void approvalFiber.dispose() })
  } catch (error) {
    for (const restore of restores.splice(0).reverse()) restore()
    throw error
  }

  return () => {
    if (disposed) return
    disposed = true
    ledger.clear()
    for (const restore of restores.splice(0).reverse()) restore()
  }
}
