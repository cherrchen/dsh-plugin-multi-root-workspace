/**
 * The operator-facing surface: the `/workspace-folders` grammar and the panel
 * channel's endpoint contract.
 *
 * The command is exercised through the definition it registers (a stub command
 * registry captures it) and the channel through the handler it hands to
 * Connection, so both are tested on the exact objects a real composition would
 * receive. The end-to-end path — a real `ctx.commands.execute()` and a real
 * browser panel — belongs to `smoke:behavior` and the client spec.
 */

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorityRpcError } from '../src/authority/protocol.ts'
import * as CommandModule from '../src/command.ts'
import { parseFoldersCommand, renderRootsReport, revealAccepted, revealArgv } from '../src/command.ts'
import { PANEL_CHANNEL, type PanelRequest, type RootsView } from '../src/contract.ts'
import { primaryKey } from '../src/roots.ts'
import type { RootStatus } from '../src/roots.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let storeRoot: string
let primary: string
let stacks: RegistryStack[] = []
let contexts: Context[] = []

/** The definitions the module registered on a stub command registry. */
const registered = new Map<string, CommandDefinition>()
/** The channel handler the module handed to the stub Connection. */
type PanelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
let handler: PanelHandler | undefined
/** Every argv the stub subprocess was asked to run. */
let spawned: string[][] = []

/** The session id panel tests send unless a case names another. */
const PANEL_SESSION = 's-1'

/** Mount a stack plus the stub registries the module needs. */
async function mount(options: {
  withPicker?: boolean
  withConnection?: boolean
  withSubprocess?: boolean
  spawnExitCode?: number
  /** Session id → cwd. `false` leaves the sessions service absent. */
  sessions?: Record<string, string> | Map<string, string> | false
  /** The `stat` the persisted-session probe consults; absent or `false` mounts no backend. */
  sessionPersistence?: { stat: (id: string, options?: { signal?: AbortSignal }) => Promise<unknown> } | false
  /** The row's config, as the patch supplies it (`dshHome` for isolate-profiles). */
  config?: { dshHome?: string }
  /** Overlay onto the registry row's own config (`remoteEnvironments` etc.). */
  registry?: Parameters<typeof mountRegistryStack>[1]
} = {}): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot, options.registry)
  stacks.push(stack)
  const ctx = stack.ctx
  registered.clear()
  handler = undefined
  spawned = []
  ctx.provide('commands', {
    register: (definition: CommandDefinition) => {
      registered.set(definition.name, definition)
      return () => {}
    },
  } as never)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: primary }),
  } as never)
  if (options.withPicker === true) {
    ctx.provide('directoryPicker', {
      capability: () => ({ kind: 'native', pick: async () => join(fixture.base, 'picked') }),
    } as never)
  }
  if (options.withConnection === true) {
    // The channel registration waits for both services and reads the service
    // off the root context (see src/command.ts); both stubs land here because
    // this spec's context IS the root.
    ctx.provide('webServer', {} as never)
    ctx.provide('connection', {
      rpc: {
        handle: (channel: string, registeredHandler: PanelHandler) => {
          expect(channel).toBe(PANEL_CHANNEL)
          handler = registeredHandler
          return async () => {}
        },
      },
    } as never)
  }
  if (options.withSubprocess === true) {
    ctx.provide('subprocess', {
      resolveExecutable: async (program: string) => `/usr/bin/${program}`,
      spawn: (spec: { argv: readonly string[] }) => {
        spawned.push([...spec.argv])
        return {
          done: Promise.resolve({ exitCode: options.spawnExitCode ?? 0, signal: null }),
          waitForExit: async () => true,
        }
      },
    } as never)
  }
  const fiber = await ctx.plugin(CommandModule, options.config ?? {})
  contexts.push(ctx)
  void fiber
  if (options.withConnection === true && options.sessions !== false) {
    await provideSessions(ctx, options.sessions ?? { [PANEL_SESSION]: primary })
  }
  if (options.sessionPersistence !== undefined && options.sessionPersistence !== false) {
    const persistence = options.sessionPersistence
    await ctx.plugin({
      name: 'sibling-session-persistence',
      apply(fiber: Context) {
        fiber.provide('sessionPersistence' as never, persistence as never)
      },
    })
  }
  return stack
}

/** Mount sessions as a sibling plugin so the lookup matches a real composition. */
async function provideSessions(
  ctx: Context,
  table: Record<string, string> | Map<string, string>,
): Promise<void> {
  await ctx.plugin({
    name: 'sibling-sessions',
    apply(fiber: Context) {
      fiber.provide('sessions', {
        get: (id: string) => {
          const cwd = table instanceof Map ? table.get(id) : table[id]
          return cwd === undefined ? undefined : { header: { cwd } }
        },
      } as never)
    },
  })
}

/** Run one command line through the registered definition. */
async function run(rawInput: string, name = 'workspace-folders'): Promise<{ kind: string; text?: string }> {
  const definition = registered.get(name)
  if (definition === undefined) throw new Error(`the module registered no command named ${name}`)
  const result = await definition.handler({
    commandId: 'cmd-1',
    agent: { session: { header: { cwd: primary } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as never)
  return result as { kind: string; text?: string }
}

/** What one channel call answered. The value is shaped per endpoint. */
interface PanelAnswer {
  readonly ok: boolean
  readonly value?: Partial<RootsView> & Partial<{ revealed: string }>
  readonly error?: { code: string }
}

/** Call one panel endpoint through the registered channel handler. */
async function callPanel(endpoint: string, payload: unknown = {}): Promise<PanelAnswer> {
  if (handler === undefined) throw new Error('the module registered no panel channel')
  return await handler(endpoint, payload, new AbortController().signal) as PanelAnswer
}

beforeEach(() => {
  fixture = createFixtureWorkspace('command')
  storeRoot = join(fixture.base, 'storages')
  mkdirSync(storeRoot)
  primary = canonicalPath(fixture.workspace)
})

afterEach(async () => {
  const pending = stacks
  stacks = []
  contexts = []
  for (const stack of pending.reverse()) await stack.dispose()
  fixture.dispose()
})

describe('parseFoldersCommand', () => {
  it('defaults to list and trims', () => {
    expect(parseFoldersCommand('')).toEqual({ verb: 'list', rest: '' })
    expect(parseFoldersCommand('   ')).toEqual({ verb: 'list', rest: '' })
    expect(parseFoldersCommand('  list  ')).toEqual({ verb: 'list', rest: '' })
  })

  it('keeps a path with spaces whole', () => {
    expect(parseFoldersCommand('add /a b/c')).toEqual({ verb: 'add', rest: '/a b/c' })
    expect(parseFoldersCommand('alias 1 my folder')).toEqual({ verb: 'alias', rest: '1 my folder' })
  })

  it('accepts every subcommand', () => {
    for (const verb of ['list', 'add', 'remove', 'alias', 'alias-id', 'skills', 'access', 'reveal', 'isolate-profiles', 'help']) {
      expect(parseFoldersCommand(`${verb} x`).verb).toBe(verb)
    }
    expect(parseFoldersCommand('isolate-profiles --apply')).toEqual({ verb: 'isolate-profiles', rest: '--apply' })
  })

  it('rejects an unknown subcommand with a stable code', () => {
    expect(() => parseFoldersCommand('nope')).toThrowError(/unknown subcommand/)
  })
})

describe('renderRootsReport', () => {
  const status = (over: Partial<RootStatus> & { path: string }): RootStatus => ({
    id: 'id-1' as RootStatus['id'],
    addedAt: '2026-09-12T00:00:00.000Z',
    state: 'available',
    access: 'read-write',
    ...over,
  })

  it('reports the primary root, an empty list, and how to add one', () => {
    const text = renderRootsReport('/ws', [])
    expect(text).toContain('Workspace root (primary; access follows the current sandbox mode): /ws')
    expect(text).toContain('No additional roots')
  })

  it('numbers additional roots from 1 and shows aliases and states', () => {
    const text = renderRootsReport('/ws', [
      status({ path: '/extra', alias: 'payments' }),
      status({ path: '/gone', state: 'missing', detail: 'the directory is not present right now' }),
      status({ path: '/nested', state: 'invalid', detail: 'overlaps /extra' }),
    ])
    expect(text).toContain('  1 /extra [payments] (read-write)')
    expect(text).toContain('  2 /gone (read-write) (missing:')
    expect(text).toContain('  3 /nested (read-write) (invalid:')
    expect(text).toContain('Writable additional roots: 1 of 3.')
    expect(text).toContain('2 root(s) are registered but not writable right now')
  })

  it('explains an unusable store instead of showing an empty list', () => {
    const text = renderRootsReport('/ws', [], 'multi_root_workspace: file is not valid JSON')
    expect(text).toContain('Root registry unavailable:')
    expect(text).not.toContain('No additional roots')
  })

  it('reports the configured limit and warns on a historical over-limit store', () => {
    const statuses = [status({ path: '/a' }), status({ path: '/b' }), status({ path: '/c' })]
    const text = renderRootsReport('/ws', statuses, undefined, 16)
    expect(text).toContain('3 of 16 additional roots.')
    expect(text).not.toContain('exceeds the configured limit')

    const over = renderRootsReport('/ws', statuses, undefined, 2)
    expect(over).toContain('3 of 2 additional roots.')
    expect(over).toContain('exceeds the configured limit of 2')
  })
})

describe('revealArgv', () => {
  it('uses the platform file manager', () => {
    expect(revealArgv('darwin', '/tmp/x')).toEqual(['open', '-R', '/tmp/x'])
    expect(revealArgv('win32', 'C:\\x')).toEqual(['explorer', '/select,C:\\x'])
    expect(revealArgv('linux', '/tmp/x')).toEqual(['xdg-open', '/tmp/x'])
  })
})

describe('revealAccepted', () => {
  it('treats explorer exit code 1 as success on Windows only', () => {
    // explorer.exe answers 1 even when it did select the item.
    expect(revealAccepted('win32', 0)).toBe(true)
    expect(revealAccepted('win32', 1)).toBe(true)
    expect(revealAccepted('win32', 2)).toBe(false)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(revealAccepted(platform, 0)).toBe(true)
      expect(revealAccepted(platform, 1)).toBe(false)
    }
    expect(revealAccepted('win32', null)).toBe(false)
  })
})

describe('the /add-dirs alias', () => {
  it('registers an add-only command with its own input hint', async () => {
    await mount()
    expect(registered.get('add-dirs')).toMatchObject({
      name: 'add-dirs',
      description: expect.stringContaining('/workspace-folders add'),
      input: { hint: '[absolute path] [--inherit|--read-only|--read-write]' },
    })
    expect(registered.has('add-dir')).toBe(false)
  })

  it.each(['', '--inherit', '--read-only', '--read-write'])(
    'shares quoted paths, access flags and the root table with the canonical command: %s',
    async flag => {
      const stack = await mount()
      const extra = join(fixture.base, 'with space')
      mkdirSync(extra)

      const added = await run(`  "${extra}" ${flag}  `, 'add-dirs')
      expect(added.kind).toBe('success')
      expect(added.text).toContain(`(${flag === '' ? 'inherit' : flag.slice(2)})`)
      expect((await run('list')).text).toBe(added.text)
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual(flag === '--read-only' ? [] : [canonicalPath(extra)])

      const duplicate = await run(`add "${extra}"`)
      expect(duplicate.kind).toBe('error')
      expect(duplicate.text).toContain('duplicate')
      expect((await run('remove 1')).kind).toBe('success')
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    },
  )

  it.each(['relative/dir', '--invalid-access', 'remove 1'])(
    'returns the same validation error as the canonical add without executing another verb: %s',
    async input => {
      const stack = await mount()
      expect(await run(input, 'add-dirs')).toEqual(await run(`add ${input}`))
      expect((await run(input, 'add-dirs')).kind).toBe('error')
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    },
  )

  it('uses the same picker and no-picker failure when the path is omitted', async () => {
    const stack = await mount({ withPicker: true })
    const picked = join(fixture.base, 'picked')
    mkdirSync(picked)
    const added = await run('--read-only', 'add-dirs')
    expect(added.kind).toBe('success')
    expect(added.text).toContain(`${canonicalPath(picked)} (read-only)`)
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])

    await mount()
    const withoutPicker = await run('', 'add-dirs')
    expect(withoutPicker.kind).toBe('error')
    expect(withoutPicker).toEqual(await run('add'))
  })

  it('preserves a withheld root\'s read-only access when re-added without a flag', async () => {
    const stack = await mount()
    const extra = join(fixture.base, 'revived')
    mkdirSync(extra)
    await run(`add ${extra} --read-only`)
    rmSync(extra, { recursive: true, force: true })
    await run('list')
    mkdirSync(extra)

    const revived = await run(extra, 'add-dirs')
    expect(revived.kind).toBe('success')
    expect(revived.text).toContain(`${canonicalPath(extra)} (read-only)`)
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
  })
})

describe('the /workspace-folders command', () => {
  it('registers the command with a hint and an English description', async () => {
    await mount()
    const definition = registered.get('workspace-folders')
    expect(definition?.name).toBe('workspace-folders')
    expect(definition?.description.length).toBeGreaterThan(0)
    expect(definition?.input?.hint).toContain('add')
  })

  it('lists, adds, aliases, moves nothing, removes, and reveals', async () => {
    const stack = await mount({ withSubprocess: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)

    expect((await run('list')).text).toContain('No additional roots')
    const added = await run(`add ${extra}`)
    expect(added.kind).toBe('success')
    expect(added.text).toContain(canonicalPath(extra))
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])

    const aliased = await run(`alias 1 payments`)
    expect(aliased.text).toContain('[payments]')

    const cleared = await run('alias 1')
    expect(cleared.text).not.toContain('[payments]')

    const revealed = await run('reveal 1')
    expect(revealed.kind).toBe('success')
    // The file manager is the platform's (open / explorer / xdg-open): the argv
    // under test is compared with the argv the plugin computes for THIS host.
    const argvUnderTest = revealArgv(process.platform, canonicalPath(extra))
    expect(spawned[0]?.slice(1)).toEqual([...argvUnderTest.slice(1)])

    const removed = await run('remove 1')
    expect(removed.text).toContain('No additional roots')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
  })

  it('accepts a quoted path and a path reference', async () => {
    const stack = await mount()
    const spaced = join(fixture.base, 'with space')
    mkdirSync(spaced)

    expect((await run(`add "${spaced}"`)).kind).toBe('success')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(spaced)])
    expect((await run(`remove "${spaced}"`)).kind).toBe('success')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
  })

  it('reports failures as error results with the stable code', async () => {
    await mount()
    const missing = join(fixture.base, 'nope')

    const missingResult = await run(`add ${missing}`)
    expect(missingResult.kind).toBe('error')
    expect(missingResult.text).toContain('missing')

    const relative = await run('add relative/dir')
    expect(relative.kind).toBe('error')
    expect(relative.text).toContain('not-absolute')

    const unknownRef = await run('remove 7')
    expect(unknownRef.kind).toBe('error')
    expect(unknownRef.text).toContain('not-found')

    const badVerb = await run('frobnicate')
    expect(badVerb.kind).toBe('error')
    expect(badVerb.text).toContain('unknown subcommand')
  })

  it('refuses to add the workspace root itself', async () => {
    await mount()
    const result = await run(`add ${primary}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('equals-primary')
  })

  it('uses the composed picker when no path is given, and reports when there is none', async () => {
    await mount({ withPicker: true })
    const picked = join(fixture.base, 'picked')
    mkdirSync(picked)
    const withPicker = await run('add')
    expect(withPicker.kind).toBe('success')
    expect(withPicker.text).toContain(canonicalPath(picked))

    await mount()
    const withoutPicker = await run('add')
    expect(withoutPicker.kind).toBe('error')
    expect(withoutPicker.text).toContain('no directory was selected')
  })

  it('re-checks the directories on every list, so a vanished root stops being writable', async () => {
    const stack = await mount()
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await run(`add ${extra}`)
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])

    rmSync(extra, { recursive: true, force: true })
    const gone = await run('list')
    expect(gone.text).toContain('missing')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    mkdirSync(extra)
    const back = await run('list')
    expect(back.text).not.toContain('missing')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
  })

  it('explains itself on help', async () => {
    await mount()
    const text = (await run('help')).text ?? ''
    expect(text).toContain('/workspace-folders add')
    expect(text).toContain('/add-dirs')
    expect(text).toContain('alias')
    expect(text).toContain('isolate-profiles')
  })

  it('isolate-profiles reports the home, the profiles, and the scan counts — read-only by default', async () => {
    const dshHome = join(fixture.base, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'default')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: {} } }))
    await mount({ config: { dshHome } })

    const check = await run('isolate-profiles')
    expect(check.kind).toBe('success')
    expect(check.text).toContain('isolate-profiles')
    expect(check.text).toContain(canonicalPath(dshHome))
    expect(check.text).toContain('default: packageImportMethod is unset')
    expect(check.text).toMatch(/scanned \d+ dirs\/\d+ files, \d+ multi-link files, \d+ uninspectable/)
    expect(check.text).toContain('--apply')
    // Read-only: nothing was written.
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).not.toContain('copy')
    expect(() => readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).toThrow()
  })

  it('isolate-profiles --apply writes the copy import and prints the remediation', async () => {
    const dshHome = join(fixture.base, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'main')
    mkdirSync(join(profileDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: {} } }))
    writeFileSync(join(profileDir, 'node_modules', 'dep', 'index.js'), 'dep')
    await mount({ config: { dshHome } })

    const applied = await run('isolate-profiles --apply')
    expect(applied.kind).toBe('success')
    expect(applied.text).toContain('main: written')
    expect(applied.text).toContain('Remove-Item -Recurse -Force')
    expect(applied.text).toContain(`pnpm --dir '${join(canonicalPath(dshHome), 'profiles', 'main')}' install`)
    expect(applied.text).toContain('does not isolate existing dependencies')
    expect(applied.text).toContain('no automatic reset')
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).toContain('packageImportMethod: copy')

    const again = await run('isolate-profiles')
    expect(again.text).toContain('main: packageImportMethod: copy')
  })

  it('isolate-profiles rejects any argument other than --apply', async () => {
    const dshHome = join(fixture.base, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })
    await mount({ config: { dshHome } })
    for (const input of ['isolate-profiles --force', 'isolate-profiles --apply --apply', 'isolate-profiles extra']) {
      const result = await run(input)
      expect(result.kind, input).toBe('error')
      expect(result.text, input).toContain('invalid-ref')
    }
  })

  it('isolate-profiles fails clearly when dshHome is missing or not absolute', async () => {
    await mount()
    const missing = await run('isolate-profiles')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('config-invalid')
    expect(missing.text).toContain('dshHome')

    await mount({ config: { dshHome: 'relative/home' } })
    const relative = await run('isolate-profiles')
    expect(relative.kind).toBe('error')
    expect(relative.text).toContain('config-invalid')
  })

  it('isolate-profiles has no panel endpoint — the channel still rejects it', async () => {
    await mount({ withConnection: true })
    const answer = await callPanel('isolate-profiles', { sessionId: PANEL_SESSION })
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('panel/bad-request')
  })
})

describe('the panel channel', () => {
  it('registers nothing when no host Connection is composed', async () => {
    await mount()
    expect(handler).toBeUndefined()
  })

  it('lists, adds, aliases, moves, reveals, and removes through ids', async () => {
    await mount({ withConnection: true, withSubprocess: true })
    const first = join(fixture.base, 'first')
    const second = join(fixture.base, 'second')
    mkdirSync(first)
    mkdirSync(second)
    const payload: PanelRequest = { sessionId: PANEL_SESSION }

    const empty = await callPanel('list', payload)
    expect(empty.ok).toBe(true)
    expect(empty.value?.primaryRoot).toBe(primary)
    expect(empty.value?.roots).toEqual([])

    await callPanel('add', { ...payload, path: first, alias: 'one' })
    const added = await callPanel('add', { ...payload, path: second })
    expect(added.value?.roots.map(root => root.path)).toEqual([canonicalPath(first), canonicalPath(second)])
    expect(added.value?.roots[0]?.alias).toBe('one')

    const firstId = added.value?.roots[0]?.id ?? ''
    const secondId = added.value?.roots[1]?.id ?? ''
    const renamed = await callPanel('alias', { ...payload, id: firstId, alias: 'renamed' })
    expect(renamed.value?.roots[0]?.alias).toBe('renamed')

    const moved = await callPanel('move', { ...payload, id: secondId, beforeId: firstId })
    expect(moved.value?.roots.map(root => root.path)).toEqual([canonicalPath(second), canonicalPath(first)])

    const revealed = await callPanel('reveal', { ...payload, id: firstId })
    expect(revealed.ok).toBe(true)
    // This endpoint answers with the revealed path, NOT with a roots view: the
    // panel parses the two differently, so the host must not blur them.
    expect(revealed.value).toEqual({ revealed: canonicalPath(first) })
    expect(revealed.value?.roots).toBeUndefined()
    expect(spawned).toHaveLength(1)

    const removed = await callPanel('remove', { ...payload, id: firstId })
    expect(removed.value?.roots.map(root => root.path)).toEqual([canonicalPath(second)])
  })

  it('derives the workspace root from the live session and never from a client path', async () => {
    const sessionRoot = canonicalPath(join(fixture.base, 'session-workspace'))
    mkdirSync(sessionRoot)
    await mount({ withConnection: true, sessions: { [PANEL_SESSION]: sessionRoot } })

    const view = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(view.ok).toBe(true)
    expect(view.value?.primaryRoot).toBe(sessionRoot)

    const missing = await callPanel('list', {})
    expect(missing.ok).toBe(false)
    expect(missing.error?.code).toBe('panel/bad-request')

    const emptyId = await callPanel('list', { sessionId: '' })
    expect(emptyId.ok).toBe(false)
    expect(emptyId.error?.code).toBe('panel/bad-request')

    const unknown = await callPanel('list', { sessionId: 'unknown' })
    expect(unknown.ok).toBe(false)
    expect(unknown.error?.code).toBe('session-not-found')

    const spoof = await callPanel('list', { sessionId: PANEL_SESSION, primaryRoot: primary })
    expect(spoof.ok).toBe(false)
    expect(spoof.error?.code).toBe('panel/bad-request')
  })

  it('answers the remote section from the control plane and refuses remote actions while it is off', async () => {
    await mount({ withConnection: true })
    const listed = await callPanel('remotes', { sessionId: PANEL_SESSION })
    expect(listed.ok).toBe(true)
    expect(listed.value).toMatchObject({ status: { state: 'disabled' }, endpoints: [] })
    const add = await callPanel('addRemote', { sessionId: PANEL_SESSION, environmentId: 'build', rootId: 'app' })
    expect(add.ok).toBe(false)
    expect(add.error?.code).toBe('remote-unavailable')
    // The primary root is host-derived; a client-named path is out of contract.
    const spoof = await callPanel('remotes', { sessionId: PANEL_SESSION, primaryRoot: '/elsewhere' })
    expect(spoof.error?.code).toBe('panel/bad-request')
  })

  it('rejects a panel call when the session disappears during the request', async () => {
    const table = new Map<string, string>([[PANEL_SESSION, primary]])
    await mount({ withConnection: true, sessions: table })

    const listed = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(listed.ok).toBe(true)
    expect(listed.value?.primaryRoot).toBe(primary)

    table.delete(PANEL_SESSION)
    const gone = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(gone.ok).toBe(false)
    expect(gone.error?.code).toBe('session-not-found')
  })

  it('rejects a panel call when the sessions service is absent', async () => {
    await mount({ withConnection: true, sessions: false })
    const result = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('session-not-found')
  })

  it('passes personal-domain error codes through dispatch instead of laundering them', async () => {
    // A malformed personal config makes sshState throw ManifestError; its
    // stable code must survive the channel so the client can localize it —
    // collapsing to panel/internal is the failure this regression watches.
    // On Windows the CredentialStore constructor fires first (no getuid), so
    // the passthrough code differs; what must never appear is panel/internal.
    const personalPath = join(fixture.base, 'personal.json')
    writeFileSync(personalPath, '{ not json', { mode: 0o600 })
    const stack = await mount({
      withConnection: true,
      registry: { remoteEnvironments: { enabled: true, mode: 'personal', personalPath, credentialRoot: join(fixture.base, 'cred') } },
    })
    expect(stack.registry.remoteMode).toBe('personal')
    const answer = await callPanel('sshState', { sessionId: PANEL_SESSION })
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe(process.platform === 'win32' ? 'credential-root-unsafe' : 'invalid-manifest')
  })

  it('reports session-not-live when the session persists but is not live in this process', async () => {
    // A persisted session another Host still owns (or one still resuming)
    // never enters this process's SessionStore; `stat` proves it exists, so
    // the failure is classified by existence, not by the live lookup alone.
    await mount({
      withConnection: true,
      sessions: { [PANEL_SESSION]: primary },
      sessionPersistence: { stat: async id => id === 's-held' ? { header: { cwd: primary } } : undefined },
    })

    const held = await callPanel('list', { sessionId: 's-held' })
    expect(held.ok).toBe(false)
    expect(held.error?.code).toBe('session-not-live')

    const heldAdd = await callPanel('add', { sessionId: 's-held', path: join(fixture.base, 'elsewhere') })
    expect(heldAdd.ok).toBe(false)
    expect(heldAdd.error?.code).toBe('session-not-live')
  })

  it('reports session-not-live when the sessions service is absent but the session persists', async () => {
    // The same classification applies when the whole sessions service is
    // missing: nothing here is live, but durable existence is still provable.
    await mount({ withConnection: true, sessions: false, sessionPersistence: { stat: async () => ({ header: { cwd: primary } }) } })
    const result = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('session-not-live')
  })

  it('keeps session-not-found when stat reports the session absent', async () => {
    await mount({ withConnection: true, sessionPersistence: { stat: async () => undefined } })
    const result = await callPanel('list', { sessionId: 's-gone' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('session-not-found')
  })

  it('keeps session-not-found when the stat probe itself fails', async () => {
    // A backend that cannot even read the header cannot prove existence; the
    // classification falls back to the code the flow already had.
    await mount({
      withConnection: true,
      sessionPersistence: { stat: async () => { throw new Error('corrupt header') } },
    })
    const result = await callPanel('list', { sessionId: 's-corrupt' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('session-not-found')
  })

  it('reports session-not-live when the session closes mid-request but persists', async () => {
    // Counter-backed store: live exactly once, so `resolvePanelPrimaryRoot`
    // passes and the `rootsViewOf` re-check is the gate that trips — the same
    // `session-not-found` code, produced by the second resolver.
    const stack = await mount({
      withConnection: true,
      sessions: false,
      sessionPersistence: { stat: async () => ({ header: { cwd: primary } }) },
    })
    let lookups = 0
    await stack.ctx.plugin({
      name: 'sibling-sessions-closing',
      apply(fiber: Context) {
        fiber.provide('sessions', {
          get: () => ++lookups === 1 ? { header: { cwd: primary } } : undefined,
        } as never)
      },
    })

    const gone = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(gone.ok).toBe(false)
    expect(gone.error?.code).toBe('session-not-live')
  })

  it('reports session-not-live when the session becomes resolvable before the failure is classified', async () => {
    // Live on the first lookup, absent only for the `rootsViewOf` re-check,
    // live again when the catch re-runs the resolver: a race that resolved —
    // the request genuinely hit a non-live window, and the retry the new
    // code promises is the healing step, not "open a session first".
    const stack = await mount({ withConnection: true, sessions: false, sessionPersistence: { stat: async () => ({ header: { cwd: primary } }) } })
    let lookups = 0
    await stack.ctx.plugin({
      name: 'sibling-sessions-flapping',
      apply(fiber: Context) {
        fiber.provide('sessions', {
          get: () => ++lookups === 2 ? undefined : { header: { cwd: primary } },
        } as never)
      },
    })

    const flapped = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(flapped.ok).toBe(false)
    expect(flapped.error?.code).toBe('session-not-live')
  })

  it('keeps session-not-found when the session is live but cannot name a workspace root', async () => {
    // A session that IS live but has no usable cwd throws the same
    // `session-not-found` at the resolver. `stat` could prove it exists on
    // disk, but "not live" would be false — the live re-check exists for
    // exactly this case, and the probe never runs.
    const stat = vi.fn(async () => ({ header: { cwd: primary } }))
    const stack = await mount({ withConnection: true, sessions: false, sessionPersistence: { stat } })
    await stack.ctx.plugin({
      name: 'sibling-sessions-broken',
      apply(fiber: Context) {
        fiber.provide('sessions', {
          get: (id: string) => id === 's-nocwd' ? { header: {} }
            : id === 's-relative' ? { header: { cwd: 'relative/path' } }
            : undefined,
        } as never)
      },
    })

    for (const sessionId of ['s-nocwd', 's-relative']) {
      const result = await callPanel('list', { sessionId })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('session-not-found')
    }
    expect(stat).not.toHaveBeenCalled()
  })

  it('reports session-not-live for a mutation whose session closed mid-request but persists', async () => {
    // The mutation commits before the view re-check trips; the failure is
    // classified the same way as `list` because both share the dispatch
    // catch. Retry stays safe: the panel's Retry re-runs `list` (a
    // reconciliation read), it does not replay the mutation.
    const stack = await mount({
      withConnection: true,
      sessions: false,
      sessionPersistence: { stat: async () => ({ header: { cwd: primary } }) },
    })
    const target = join(fixture.base, 'mid-request-add')
    mkdirSync(target)
    let lookups = 0
    await stack.ctx.plugin({
      name: 'sibling-sessions-closing',
      apply(fiber: Context) {
        fiber.provide('sessions', {
          get: () => ++lookups === 1 ? { header: { cwd: primary } } : undefined,
        } as never)
      },
    })

    const added = await callPanel('add', { sessionId: PANEL_SESSION, path: target })
    expect(added.ok).toBe(false)
    expect(added.error?.code).toBe('session-not-live')
    // Committed despite the error response: the root is already registered.
    expect(stack.registry.list(primary).map(status => status.path)).toContain(canonicalPath(target))
  })

  it('passes authority errors through without consulting the persistence probe', async () => {
    const stat = vi.fn(async () => ({ header: { cwd: primary } }))
    const stack = await mount({ withConnection: true, sessionPersistence: { stat } })
    vi.spyOn(stack.registry, 'refresh').mockRejectedValueOnce(new AuthorityRpcError('authority/contended', 'registry is contended'))

    const contended = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(contended.ok).toBe(false)
    expect(contended.error?.code).toBe('authority/contended')
    expect(stat).not.toHaveBeenCalled()
  })

  it('keeps session-not-found when the live lookup itself throws during classification', async () => {
    // First lookup answers "absent" so the resolver throws; the catch-time
    // resolver re-run and the live re-check then throw — an unanswerable
    // live state cannot prove "not live", so the probe never runs and the
    // flow's own code stands.
    const stat = vi.fn(async () => ({ header: { cwd: primary } }))
    const stack = await mount({ withConnection: true, sessions: false, sessionPersistence: { stat } })
    let lookups = 0
    await stack.ctx.plugin({
      name: 'sibling-sessions-exploding',
      apply(fiber: Context) {
        fiber.provide('sessions', {
          get: () => { if (++lookups === 1) return undefined; throw new Error('sessions exploded') },
        } as never)
      },
    })

    const exploded = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(exploded.ok).toBe(false)
    expect(exploded.error?.code).toBe('session-not-found')
    expect(stat).not.toHaveBeenCalled()
  })

  it('does not probe persistence for non-session failures', async () => {
    const stat = vi.fn(async () => ({ header: { cwd: primary } }))
    await mount({ withConnection: true, sessionPersistence: { stat } })

    const missing = await callPanel('add', { sessionId: PANEL_SESSION, path: join(fixture.base, 'does-not-exist') })
    expect(missing.ok).toBe(false)
    expect(missing.error?.code).toBe('missing')
    expect(stat).not.toHaveBeenCalled()
  })

  it('carries the workspace title as primaryName when the registry knows it', async () => {
    // Membership wins: the session belongs to a workspace, and its upstream
    // title is what the primary row displays.
    const memberStack = await mount({ withConnection: true })
    await memberStack.ctx.plugin({
      name: 'sibling-workspace-registry',
      apply(ctx: Context) {
        ctx.provide('workspaceRegistry', {
          list: () => [{ title: 'Payments Platform', sessionIds: [PANEL_SESSION] }],
          resolveByPath: async () => {
            throw new Error('membership must resolve the name before the path does')
          },
        } as never)
      },
    })
    const member = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(member.value?.primaryName).toBe('Payments Platform')

    // No membership: the session cwd resolves by path.
    const pathStack = await mount({ withConnection: true })
    await pathStack.ctx.plugin({
      name: 'sibling-workspace-registry-path',
      apply(ctx: Context) {
        ctx.provide('workspaceRegistry', {
          list: () => [],
          resolveByPath: async (path: string) => (path === primary ? { title: 'Path Match' } : undefined),
        } as never)
      },
    })
    const byPath = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(byPath.value?.primaryName).toBe('Path Match')

    // Neither resolves: the field stays absent and the panel falls back to the
    // path basename.
    const emptyStack = await mount({ withConnection: true })
    await emptyStack.ctx.plugin({
      name: 'sibling-workspace-registry-empty',
      apply(ctx: Context) {
        ctx.provide('workspaceRegistry', {
          list: () => [],
          resolveByPath: async () => undefined,
        } as never)
      },
    })
    const absent = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(absent.value?.primaryName).toBeUndefined()
  })

  it('reports contract failures with codes instead of throwing', async () => {
    await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { sessionId: PANEL_SESSION, path: extra })

    const duplicate = await callPanel('add', { sessionId: PANEL_SESSION, path: extra })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.error?.code).toBe('duplicate')

    const unknownEndpoint = await callPanel('frobnicate', { sessionId: PANEL_SESSION })
    expect(unknownEndpoint.error?.code).toBe('panel/bad-request')

    const noId = await callPanel('remove', { sessionId: PANEL_SESSION })
    expect(noId.error?.code).toBe('invalid-ref')
  })

  it('re-checks the directories on every list, exactly like the command does', async () => {
    const stack = await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { sessionId: PANEL_SESSION, path: extra })

    rmSync(extra, { recursive: true, force: true })
    const gone = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(gone.value?.roots?.[0]?.state).toBe('missing')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    mkdirSync(extra)
    const back = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(back.value?.roots?.[0]?.state).toBe('available')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
  })

  it('withholds a root whose directory was swapped for a symlink', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const stack = await mount({ withConnection: true, withSubprocess: true })
    // Canonical spellings up front: after the swap, `canonicalPath(granted)`
    // IS `elsewhere`, so the test must compare against the pre-swap names.
    const granted = canonicalPath(join(fixture.base, 'granted'))
    const elsewhere = canonicalPath(join(fixture.base, 'elsewhere'))
    mkdirSync(granted)
    mkdirSync(elsewhere)
    const added = await callPanel('add', { sessionId: PANEL_SESSION, path: granted })
    const id = added.value?.roots?.[0]?.id ?? ''

    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)

    const view = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(view.value?.roots?.[0]?.state).toBe('redirected')
    // The registration still names the directory the operator gave; where it
    // resolves now is reported as the reason, not as the path.
    expect(view.value?.roots?.[0]?.path).toBe(granted)
    expect(view.value?.roots?.[0]?.detail).toContain(elsewhere)
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    // Revealing reports what it revealed, and revealing is still allowed: it is
    // an operator action, not a grant.
    const revealed = await callPanel('reveal', { sessionId: PANEL_SESSION, id })
    expect(revealed.value?.revealed).toBe(granted)
  })

  it('reports a reveal that cannot run as reveal-unavailable, not a storage failure', async () => {
    // Reveal has nothing to do with the root registry's store; its failures get
    // their own code so the panel cannot render the storage-repair guidance.
    await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { sessionId: PANEL_SESSION, path: extra })

    const withoutRuntime = await callPanel('reveal', { sessionId: PANEL_SESSION })
    expect(withoutRuntime.ok).toBe(false)
    expect(withoutRuntime.error?.code).toBe('invalid-ref')

    const added = await callPanel('list', { sessionId: PANEL_SESSION })
    const id = added.value?.roots?.[0]?.id ?? ''
    const noSubprocess = await callPanel('reveal', { sessionId: PANEL_SESSION, id })
    expect(noSubprocess.ok).toBe(false)
    expect(noSubprocess.error?.code).toBe('reveal-unavailable')
    expect((await run('reveal 1')).text).toContain('reveal-unavailable')
  })

  it('reports a failing file manager as reveal-unavailable', async () => {
    // Exit code 1 is a SUCCESS on Windows (explorer.exe semantics), so the
    // failing file manager must report a code that is a failure everywhere.
    await mount({ withConnection: true, withSubprocess: true, spawnExitCode: 2 })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { sessionId: PANEL_SESSION, path: extra })
    const added = await callPanel('list', { sessionId: PANEL_SESSION })
    const id = added.value?.roots?.[0]?.id ?? ''

    const failed = await callPanel('reveal', { sessionId: PANEL_SESSION, id })
    expect(failed.ok).toBe(false)
    expect(failed.error?.code).toBe('reveal-unavailable')
    expect(spawned).toHaveLength(1)
  })

  it('removes exactly one record when two records share an id', async () => {
    const stack = await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    const twinned = join(fixture.base, 'twinned')
    mkdirSync(extra)
    mkdirSync(twinned)
    await callPanel('add', { sessionId: PANEL_SESSION, path: extra })

    // Hand-write the duplicate into the store, then restart the registry.
    const storeFile = join(storeRoot, 'multi_root_workspace.json')
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; recordedPath: string; addedAt: string }[] }> }
    }
    const record = document.tables.roots[primaryKey(primary)]!
    const [entry] = record.roots
    record.roots.push({ ...entry!, path: twinned, recordedPath: canonicalPath(twinned) })
    writeFileSync(storeFile, JSON.stringify(document))
    await stack.dispose()
    stacks = stacks.filter(candidate => candidate !== stack)
    const restarted = await mount({ withConnection: true })

    const listed = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(listed.value?.roots?.map(root => root.state)).toEqual(['invalid', 'invalid'])
    expect(restarted.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    const listedEntry = listed.value!.roots![1]!
    const removed = await callPanel('remove', {
      sessionId: PANEL_SESSION,
      entry: {
        ordinal: listedEntry.ordinal,
        id: listedEntry.id,
        path: listedEntry.path,
        addedAt: listedEntry.addedAt,
      },
    })
    expect(removed.value?.roots).toHaveLength(1)
    expect(removed.value?.roots?.[0]?.path).toBe(canonicalPath(extra))
  })

  it('keeps the command ordinal when duplicate ids make id lookup ambiguous', async () => {
    const stack = await mount()
    const first = join(fixture.base, 'first')
    const second = join(fixture.base, 'second')
    mkdirSync(first)
    mkdirSync(second)
    await stack.registry.add(primary, { path: first })
    const storeFile = join(storeRoot, 'multi_root_workspace.json')
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; recordedPath: string; addedAt: string }[] }> }
    }
    const entry = document.tables.roots[primaryKey(primary)]!.roots[0]!
    document.tables.roots[primaryKey(primary)]!.roots.push({ ...entry, path: second, recordedPath: canonicalPath(second) })
    writeFileSync(storeFile, JSON.stringify(document))
    await stack.dispose()
    stacks = stacks.filter(candidate => candidate !== stack)
    await mount()

    const result = await run('remove 2')

    expect(result.kind).toBe('success')
    expect(result.text).toContain(canonicalPath(first))
    expect(result.text).not.toContain(canonicalPath(second))
  })

  it('rejects a payload that is not a request body', async () => {
    await mount({ withConnection: true })

    const notAnObject = await callPanel('list', 'primary' as never)
    expect(notAnObject.error?.code).toBe('panel/bad-request')

    const unknownKey = await handler!('list', { sessionId: PANEL_SESSION, sneaky: true }, new AbortController().signal) as PanelAnswer
    expect(unknownKey.error?.code).toBe('panel/bad-request')

    const wrongType = await handler!('list', { sessionId: 7 }, new AbortController().signal) as PanelAnswer
    expect(wrongType.error?.code).toBe('panel/bad-request')

    const namedRoot = await handler!('list', { sessionId: PANEL_SESSION, primaryRoot: primary }, new AbortController().signal) as PanelAnswer
    expect(namedRoot.error?.code).toBe('panel/bad-request')
  })

  it('surfaces registry failures as errors rather than an empty list', async () => {
    const stack = await mount({ withConnection: true })
    // A registry that cannot read its store reports the reason on every read.
    Object.defineProperty(stack.registry, 'unavailable', { get: () => 'multi_root_workspace: file is not valid JSON' })
    const view = await callPanel('list', { sessionId: PANEL_SESSION })
    expect(view.ok).toBe(true)
    expect(view.value?.unavailable).toContain('multi_root_workspace')
  })
})

it('shows effective cwd while root management stays bound to the session origin', async () => {
  const stack = await mount({ withConnection: true })
  await stack.ctx.plugin({ name: 'directory-display', apply(ctx: Context) {
    ctx.provide('workingDirectory' as never, { get: () => fixture.outside } as never)
  } })
  const result = await callPanel('list', { sessionId: PANEL_SESSION })
  expect(result.value?.primaryRoot).toBe(primary)
  expect(result.value?.effectiveCwd).toBe(fixture.outside)
  expect(result.value?.roots).toEqual([])
})

describe('per-root access on the command and the panel', () => {
  it('registers a read-only root with `add <path> --read-only` and reports access in list', async () => {
    const stack = await mount()
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)

    const added = await run(`add ${extra} --read-only`)
    expect(added.kind).toBe('success')
    expect(added.text).toContain(`${canonicalPath(extra)} (read-only)`)
    // A read-only member stays registered but is not a writable root.
    expect(added.text).toContain('Writable additional roots under the current mode: 0 of 1.')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
  })

  it('toggles access with `access <ref> read-only|read-write` and rejects other levels', async () => {
    const stack = await mount()
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await run(`add ${extra}`)

    const downgraded = await run(`access 1 read-only`)
    expect(downgraded.kind).toBe('success')
    expect(downgraded.text).toContain('(read-only)')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])

    const upgraded = await run(`access 1 read-write`)
    expect(upgraded.kind).toBe('success')
    expect(upgraded.text).toContain('(read-write)')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([canonicalPath(extra)])

    const bad = await run(`access 1 readwrite`)
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('inherit, read-only, or read-write')
  })

  it('revives a withheld read-only root without upgrading it, unless a flag says so', async () => {
    const stack = await mount()
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await run(`add ${extra} --read-only`)

    // Withhold the record, let the operator OBSERVE it missing, then bring the
    // directory back: the bare re-add is a revive — the withheld last
    // observation is exactly what revive detection looks at — not a new
    // registration, so the stored access must be kept.
    rmSync(extra, { recursive: true, force: true })
    await run('list')
    mkdirSync(extra)

    // No flag may not send a level at all: the command used to forward its own
    // read-write default, which the registry then honored as an explicit
    // upgrade and the root gained write authority silently.
    const revived = await run(`add ${extra}`)
    expect(revived.kind).toBe('success')
    expect(revived.text).toContain(`${canonicalPath(extra)} (read-only)`)
    expect(revived.text).not.toContain('(read-write)')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])

    // An explicit flag is the upgrade on the same revive path.
    rmSync(extra, { recursive: true, force: true })
    await run('list')
    mkdirSync(extra)
    const upgraded = await run(`add ${extra} --read-write`)
    expect(upgraded.kind).toBe('success')
    expect(upgraded.text).toContain(`${canonicalPath(extra)} (read-write)`)
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([canonicalPath(extra)])
  })

  it('manages namespace and Skills through command and matching panel mutations', async () => {
    await mount({ withConnection: true })
    const root = join(fixture.base, 'skills-command')
    mkdirSync(root)
    expect((await run(`add ${root}`)).kind).toBe('success')
    expect((await run('skills 1 off')).kind).toBe('success')
    expect((await run('alias-id 1 command-root')).kind).toBe('success')
    const payload = { sessionId: PANEL_SESSION }
    const listed = await callPanel('list', payload)
    expect(listed.ok).toBe(true)
    const entry = listed.value!.roots[0]!
    expect(entry).toMatchObject({ skillsEnabled: false, aliasId: 'command-root' })
    const enabled = await callPanel('setSkillsEnabled', { ...payload, id: entry.id, skillsEnabled: true })
    expect(enabled).toMatchObject({ ok: true, value: { roots: [expect.objectContaining({ skillsEnabled: true })] } })
    expect(await callPanel('setAliasId', { ...payload, id: entry.id, aliasId: 'panel-root' })).toMatchObject({ ok: true })
    expect(await callPanel('setSkillsEnabled', { ...payload, id: entry.id, skillsEnabled: 'yes' })).toMatchObject({ ok: false })
  })

  it('carries access through the panel add/setAccess endpoints as a RootsView', async () => {
    await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    const payload: PanelRequest = { sessionId: PANEL_SESSION }

    const added = await callPanel('add', { ...payload, path: extra, access: 'read-only' })
    expect(added.ok).toBe(true)
    expect(added.value?.roots[0]?.access).toBe('read-only')
    const root = added.value?.roots[0]!
    const entry = { ordinal: root.ordinal, id: root.id, path: root.path, addedAt: root.addedAt }

    const missing = await callPanel('setAccess', { ...payload, entry })
    expect(missing.error?.code).toBe('invalid-ref')

    const upgraded = await callPanel('setAccess', { ...payload, entry, access: 'read-write' })
    expect(upgraded.ok).toBe(true)
    expect(upgraded.value?.roots[0]?.access).toBe('read-write')
  })

  it('rejects an out-of-contract access value at the wire boundary', async () => {
    await mount({ withConnection: true })
    const result = await callPanel('add', { sessionId: PANEL_SESSION, path: fixture.outside, access: 'execute' })
    expect(result.error?.code).toBe('panel/bad-request')
  })
})

it.each(['duplicate', 'authority-disconnected'])('preserves shared authority errors on command and panel surfaces: %s', async code => {
  const stack = await mount({ withConnection: true })
  const message = code === 'authority-disconnected' ? 'registry request result is unknown; resynchronize before another mutation' : 'duplicate root'
  const spy = vi.spyOn(stack.registry, 'add').mockRejectedValue(new AuthorityRpcError(code, message))
  try {
    expect((await run(`add ${fixture.outside}`)).text).toContain(`${code}: ${message}`)
    expect(await callPanel('add', { sessionId: PANEL_SESSION, path: fixture.outside })).toMatchObject({ ok: false, error: { code, message } })
  } finally { spy.mockRestore() }
})
