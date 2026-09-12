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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as CommandModule from '../src/command.ts'
import { parseFoldersCommand, renderRootsReport, revealArgv } from '../src/command.ts'
import { PANEL_CHANNEL, type PanelRequest, type RootsView } from '../src/contract.ts'
import type { RootStatus } from '../src/roots.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let storeRoot: string
let primary: string
let stacks: RegistryStack[] = []
let contexts: Context[] = []

/** The definition the module registered on a stub command registry. */
let registered: CommandDefinition | undefined
/** The channel handler the module handed to the stub Connection. */
type PanelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
let handler: PanelHandler | undefined
/** Every argv the stub subprocess was asked to run. */
let spawned: string[][] = []
/** The code the stub subprocess reports. */
const exitCode: number | null = 0

/** Mount a stack plus the stub registries the module needs. */
async function mount(options: { withPicker?: boolean; withConnection?: boolean; withSubprocess?: boolean } = {}): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot)
  stacks.push(stack)
  const ctx = stack.ctx
  registered = undefined
  handler = undefined
  spawned = []
  ctx.provide('commands', {
    register: (definition: CommandDefinition) => {
      registered = definition
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
          done: Promise.resolve({ exitCode, signal: null }),
          waitForExit: async () => true,
        }
      },
    } as never)
  }
  const fiber = await ctx.plugin(CommandModule)
  contexts.push(ctx)
  void fiber
  return stack
}

/** Run one command line through the registered definition. */
async function run(rawInput: string): Promise<{ kind: string; text?: string }> {
  if (registered === undefined) throw new Error('the module registered no command')
  const result = await registered.handler({
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
async function callPanel(endpoint: string, payload: PanelRequest = {}): Promise<PanelAnswer> {
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
    for (const verb of ['list', 'add', 'remove', 'alias', 'reveal', 'help']) {
      expect(parseFoldersCommand(`${verb} x`).verb).toBe(verb)
    }
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
    ...over,
  })

  it('reports the primary root, an empty list, and how to add one', () => {
    const text = renderRootsReport('/ws', [])
    expect(text).toContain('Workspace root (primary, always writable): /ws')
    expect(text).toContain('No additional roots')
  })

  it('numbers additional roots from 1 and shows aliases and states', () => {
    const text = renderRootsReport('/ws', [
      status({ path: '/extra', alias: 'payments' }),
      status({ path: '/gone', state: 'missing', detail: 'the directory is not present right now' }),
      status({ path: '/nested', state: 'invalid', detail: 'overlaps /extra' }),
    ])
    expect(text).toContain('  1 /extra [payments]')
    expect(text).toContain('  2 /gone (missing:')
    expect(text).toContain('  3 /nested (invalid:')
    expect(text).toContain('Writable additional roots: 1 of 3.')
    expect(text).toContain('2 root(s) are registered but not writable right now')
  })

  it('explains an unusable store instead of showing an empty list', () => {
    const text = renderRootsReport('/ws', [], 'multi_root_workspace: file is not valid JSON')
    expect(text).toContain('Root registry unavailable:')
    expect(text).not.toContain('No additional roots')
  })
})

describe('revealArgv', () => {
  it('uses the platform file manager', () => {
    expect(revealArgv('darwin', '/tmp/x')).toEqual(['open', '-R', '/tmp/x'])
    expect(revealArgv('win32', 'C:\\x')).toEqual(['explorer', '/select,C:\\x'])
    expect(revealArgv('linux', '/tmp/x')).toEqual(['xdg-open', '/tmp/x'])
  })
})

describe('the /workspace-folders command', () => {
  it('registers the command with a hint and an English description', async () => {
    await mount()
    expect(registered?.name).toBe('workspace-folders')
    expect(registered?.description.length).toBeGreaterThan(0)
    expect(registered?.input?.hint).toContain('add')
  })

  it('lists, adds, aliases, moves nothing, removes, and reveals', async () => {
    const stack = await mount({ withSubprocess: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)

    expect((await run('list')).text).toContain('No additional roots')
    const added = await run(`add ${extra}`)
    expect(added.kind).toBe('success')
    expect(added.text).toContain(canonicalPath(extra))
    expect(stack.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])

    const aliased = await run(`alias 1 payments`)
    expect(aliased.text).toContain('[payments]')

    const cleared = await run('alias 1')
    expect(cleared.text).not.toContain('[payments]')

    const revealed = await run('reveal 1')
    expect(revealed.kind).toBe('success')
    expect(spawned[0]?.[0]).toBe('/usr/bin/open')
    expect(spawned[0]?.[2]).toBe(canonicalPath(extra))

    const removed = await run('remove 1')
    expect(removed.text).toContain('No additional roots')
    expect(stack.scope.scopeOf(primary)).toEqual([])
  })

  it('accepts a quoted path and a path reference', async () => {
    const stack = await mount()
    const spaced = join(fixture.base, 'with space')
    mkdirSync(spaced)

    expect((await run(`add "${spaced}"`)).kind).toBe('success')
    expect(stack.scope.scopeOf(primary)).toEqual([canonicalPath(spaced)])
    expect((await run(`remove "${spaced}"`)).kind).toBe('success')
    expect(stack.scope.scopeOf(primary)).toEqual([])
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
    expect(stack.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])

    rmSync(extra, { recursive: true, force: true })
    const gone = await run('list')
    expect(gone.text).toContain('missing')
    expect(stack.scope.scopeOf(primary)).toEqual([])

    mkdirSync(extra)
    const back = await run('list')
    expect(back.text).not.toContain('missing')
    expect(stack.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])
  })

  it('explains itself on help', async () => {
    await mount()
    const text = (await run('help')).text ?? ''
    expect(text).toContain('/workspace-folders add')
    expect(text).toContain('alias')
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
    const payload: PanelRequest = { primaryRoot: primary }

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

  it('resolves the workspace root from the session when the client omits it', async () => {
    const stack = await mount({ withConnection: true })
    stack.ctx.provide('sessions', {
      get: (id: string) => (id === 's-1' ? { header: { cwd: primary } } : undefined),
    } as never)

    const view = await callPanel('list', { sessionId: 's-1' })
    expect(view.value?.primaryRoot).toBe(primary)

    const fallback = await callPanel('list', {})
    expect(fallback.value?.primaryRoot).toBe(primary)
  })

  it('reports contract failures with codes instead of throwing', async () => {
    await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { primaryRoot: primary, path: extra })

    const duplicate = await callPanel('add', { primaryRoot: primary, path: extra })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.error?.code).toBe('duplicate')

    const unknownEndpoint = await callPanel('frobnicate', { primaryRoot: primary })
    expect(unknownEndpoint.error?.code).toBe('panel/bad-request')

    const badRoot = await callPanel('list', { primaryRoot: join(fixture.base, 'missing') })
    expect(badRoot.error?.code).toBe('missing')

    const noId = await callPanel('remove', { primaryRoot: primary })
    expect(noId.error?.code).toBe('invalid-ref')
  })

  it('re-checks the directories on every list, exactly like the command does', async () => {
    const stack = await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    mkdirSync(extra)
    await callPanel('add', { primaryRoot: primary, path: extra })

    rmSync(extra, { recursive: true, force: true })
    const gone = await callPanel('list', { primaryRoot: primary })
    expect(gone.value?.roots?.[0]?.state).toBe('missing')
    expect(stack.scope.scopeOf(primary)).toEqual([])

    mkdirSync(extra)
    const back = await callPanel('list', { primaryRoot: primary })
    expect(back.value?.roots?.[0]?.state).toBe('available')
    expect(stack.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])
  })

  it('withholds a root whose directory was swapped for a symlink', async () => {
    const stack = await mount({ withConnection: true, withSubprocess: true })
    // Canonical spellings up front: after the swap, `canonicalPath(granted)`
    // IS `elsewhere`, so the test must compare against the pre-swap names.
    const granted = canonicalPath(join(fixture.base, 'granted'))
    const elsewhere = canonicalPath(join(fixture.base, 'elsewhere'))
    mkdirSync(granted)
    mkdirSync(elsewhere)
    const added = await callPanel('add', { primaryRoot: primary, path: granted })
    const id = added.value?.roots?.[0]?.id ?? ''

    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)

    const view = await callPanel('list', { primaryRoot: primary })
    expect(view.value?.roots?.[0]?.state).toBe('redirected')
    // The registration still names the directory the operator gave; where it
    // resolves now is reported as the reason, not as the path.
    expect(view.value?.roots?.[0]?.path).toBe(granted)
    expect(view.value?.roots?.[0]?.detail).toContain(elsewhere)
    expect(stack.scope.scopeOf(primary)).toEqual([])
    // Revealing reports what it revealed, and revealing is still allowed: it is
    // an operator action, not a grant.
    const revealed = await callPanel('reveal', { primaryRoot: primary, id })
    expect(revealed.value?.revealed).toBe(granted)
  })

  it('removes exactly one record when two records share an id', async () => {
    const stack = await mount({ withConnection: true })
    const extra = join(fixture.base, 'extra')
    const twinned = join(fixture.base, 'twinned')
    mkdirSync(extra)
    mkdirSync(twinned)
    await callPanel('add', { primaryRoot: primary, path: extra })

    // Hand-write the duplicate into the store, then restart the registry.
    const storeFile = join(storeRoot, 'multi_root_workspace.json')
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; recordedPath: string; addedAt: string }[] }> }
    }
    const record = document.tables.roots[primary]!
    const [entry] = record.roots
    record.roots.push({ ...entry!, path: twinned, recordedPath: canonicalPath(twinned) })
    writeFileSync(storeFile, JSON.stringify(document))
    await stack.dispose()
    stacks = stacks.filter(candidate => candidate !== stack)
    const restarted = await mount({ withConnection: true })

    const listed = await callPanel('list', { primaryRoot: primary })
    expect(listed.value?.roots?.map(root => root.state)).toEqual(['invalid', 'invalid'])
    expect(restarted.scope.scopeOf(primary)).toEqual([])

    const removed = await callPanel('remove', { primaryRoot: primary, id: entry!.id })
    expect(removed.value?.roots).toHaveLength(1)
    expect(removed.value?.roots?.[0]?.path).toBe(canonicalPath(twinned))
  })

  it('rejects a payload that is not a request body', async () => {
    await mount({ withConnection: true })

    const notAnObject = await callPanel('list', 'primary' as never)
    expect(notAnObject.error?.code).toBe('panel/bad-request')

    const unknownKey = await handler!('list', { primaryRoot: primary, sneaky: true }, new AbortController().signal) as PanelAnswer
    expect(unknownKey.error?.code).toBe('panel/bad-request')

    const wrongType = await handler!('list', { primaryRoot: 7 }, new AbortController().signal) as PanelAnswer
    expect(wrongType.error?.code).toBe('panel/bad-request')
  })

  it('surfaces registry failures as errors rather than an empty list', async () => {
    const stack = await mount({ withConnection: true })
    // A registry that cannot read its store reports the reason on every read.
    Object.defineProperty(stack.registry, 'unavailable', { get: () => 'multi_root_workspace: file is not valid JSON' })
    const view = await callPanel('list', { primaryRoot: primary })
    expect(view.ok).toBe(true)
    expect(view.value?.unavailable).toContain('multi_root_workspace')
  })
})
