import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Lsp } from '@deepseek-ai/dsh-lsp'
import * as LspStdio from '@deepseek-ai/dsh-lsp-stdio'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it } from 'vitest'
import MultiRootScope from '../src/scope.ts'
import * as Routing from '../src/lsp.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, REPO_ROOT, type FixtureWorkspace } from './support/temp-workspace.ts'

interface HoverPayload {
  readonly cwd: string
  readonly rootUri: string
  readonly workspaceFolders: readonly { uri: string }[]
  readonly document: { uri: string; text: string }
  readonly pid: number
}

const SERVER = join(REPO_ROOT, 'tests/support/lsp-server.mjs')

/** Mount the real upstream Lsp + stdio provider + routing over one fixture. */
async function mountLsp(fixture: FixtureWorkspace, cwd = fixture.workspace): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(Lsp)
  await ctx.plugin(MultiRootScope)
  await mountCompat(ctx)
  // The routing row injects the provider-conflict gate; the LocalFileSystem
  // above plays this bundle's provider, so the gate brands it.
  await mountProviderGate(ctx)
  const fiber = await ctx.plugin(Routing)
  await ctx.plugin(LspStdio, { servers: { fixture: { command: process.execPath, args: [SERVER], extensionToLanguage: { '.ts': 'typescript' } } } })
  return { ctx, fiber }
}

function hoverOf(result: { kind: string; hover?: { contents: string } | null }): HoverPayload {
  if (result.kind !== 'hover' || result.hover === undefined || result.hover === null) throw new Error(`expected hover, got ${result.kind}`)
  return JSON.parse(result.hover.contents) as HoverPayload
}

it('initializes and pools real stdio servers independently for the primary and additional roots', async () => {
  const fixture = createFixtureWorkspace('lsp-stdio')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Lsp)
    await ctx.plugin(MultiRootScope)
    await mountCompat(ctx)
    await mountProviderGate(ctx)
    await ctx.plugin(Routing)
    await ctx.plugin(LspStdio, { servers: { fixture: { command: process.execPath, args: [SERVER], extensionToLanguage: { '.ts': 'typescript' } } } })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
    for (const root of [fixture.workspace, fixture.outside]) writeFileSync(join(root, 'same.ts'), `const value = ${JSON.stringify(root)};`)
    const query = (filePath: string) => ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath, operation: 'hover', position: { line: 0, character: 6 } })
    const primary = await query('same.ts')
    const additional = await query('../out/same.ts')
    if (primary.kind !== 'hover' || additional.kind !== 'hover') throw new Error('expected hover')
    const first = JSON.parse(primary.hover!.contents)
    const second = JSON.parse(additional.hover!.contents)
    expect(first.cwd).toBe(canonicalPath(fixture.workspace)); expect(second.cwd).toBe(canonicalPath(fixture.outside))
    expect(second.rootUri).toBe(pathToFileURL(canonicalPath(fixture.outside)).href)
    expect(second.workspaceFolders[0].uri).toBe(second.rootUri)
    expect(first.document.text).toBe(readFileSync(join(fixture.workspace, 'same.ts'), 'utf8'))
    expect(second.document.text).toBe(readFileSync(join(fixture.outside, 'same.ts'), 'utf8'))
    expect(first.pid).not.toBe(second.pid)
    const repeat = await query(join(fixture.outside, 'same.ts'))
    if (repeat.kind !== 'hover') throw new Error('expected hover')
    expect(JSON.parse(repeat.hover!.contents).pid).toBe(second.pid)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await expect(query('../out/same.ts')).rejects.toThrow('outside the workspace')
  } finally { await ctx.fiber.dispose(); fixture.dispose() }
})

describe('real stdio servers across session origins and edge roots', () => {
  it('serves two concurrent sessions by their own primary, and pools three same-named files apart', async () => {
    const fixture = createFixtureWorkspace('lsp-sessions')
    const second = join(fixture.base, 'p2')
    mkdirSync(second)
    const { ctx } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      for (const root of [fixture.workspace, fixture.outside, second]) writeFileSync(join(root, 'same.ts'), `const value = ${JSON.stringify(root)};`)
      const waterfall = ctx.waterfall.bind(ctx) as (event: string, payload: { agent: { session: { header: { cwd: string } } } }, next: () => Promise<unknown>) => Promise<{ kind: string; hover?: { contents: string } }>
      const queryIn = (origin: string, filePath: string, workspaceRoot: string) => waterfall('tools/execute', { agent: { session: { header: { cwd: origin } } } },
        async () => await ctx.lsp.query({ workspaceRoot, filePath, operation: 'hover', position: { line: 0, character: 6 } }))
      const additionalFile = join(fixture.outside, 'same.ts')
      const [routed, rejected, one, two, three] = await Promise.all([
        queryIn(fixture.workspace, additionalFile, fixture.workspace),
        queryIn(second, additionalFile, second).then(() => 'served' as const, () => 'rejected' as const),
        queryIn(fixture.workspace, 'same.ts', fixture.workspace),
        queryIn(second, 'same.ts', second),
        queryIn(fixture.workspace, additionalFile, fixture.workspace),
      ])
      // P1's query on X/same.ts is served by X's own server; P2's identical
      // file is outside ITS workspace and is refused.
      expect(hoverOf(routed).rootUri).toBe(pathToFileURL(canonicalPath(fixture.outside)).href)
      expect(rejected).toBe('rejected')
      const pids = new Set([hoverOf(one).pid, hoverOf(two).pid, hoverOf(three).pid])
      expect(pids.size).toBe(3)
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it('opens a root whose name has spaces and Unicode', async () => {
    const fixture = createFixtureWorkspace('lsp-unicode')
    const named = join(fixture.base, '根 目录 ü')
    mkdirSync(named)
    writeFileSync(join(named, 'uni.ts'), 'const u = 1\n')
    const { ctx } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'uni', path: named, recordedPath: canonicalPath(named) }])
      const result = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(named, 'uni.ts'), operation: 'hover', position: { line: 0, character: 6 } })
      const payload = hoverOf(result)
      expect(payload.rootUri).toBe(pathToFileURL(canonicalPath(named)).href)
      expect(payload.document.text).toBe(readFileSync(join(named, 'uni.ts'), 'utf8'))
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it('cancels an in-flight query promptly and keeps the server usable', async () => {
    const fixture = createFixtureWorkspace('lsp-cancel')
    writeFileSync(join(fixture.outside, 'slow.ts'), 'const s = 1 // SLOW_HOVER\n')
    writeFileSync(join(fixture.outside, 'fast.ts'), 'const f = 1\n')
    const { ctx } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const controller = new AbortController()
      const started = Date.now()
      const pending = ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'slow.ts'), operation: 'hover', position: { line: 0, character: 6 } }, controller.signal)
      const timer = setTimeout(() => { controller.abort(new Error('canceled')) }, 300)
      try {
        await expect(pending).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(2000)
      } finally {
        clearTimeout(timer)
      }
      // The same root must still answer (the server lives, or was respawned).
      const after = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'fast.ts'), operation: 'hover', position: { line: 0, character: 6 } })
      expect(hoverOf(after).rootUri).toBe(pathToFileURL(canonicalPath(fixture.outside)).href)
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it('survives a server crash without hanging the next query', async () => {
    const fixture = createFixtureWorkspace('lsp-crash')
    writeFileSync(join(fixture.outside, 'crash.ts'), 'const c = 1 // CRASH_HOVER\n')
    writeFileSync(join(fixture.outside, 'well.ts'), 'const w = 1\n')
    const { ctx } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      await expect(ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'crash.ts'), operation: 'hover', position: { line: 0, character: 6 } })).rejects.toThrow()
      // Whether upstream respawns or reports, the next query must settle, not hang.
      const settled = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'well.ts'), operation: 'hover', position: { line: 0, character: 6 } })
        .then(() => 'served' as const, () => 'failed' as const)
      expect(settled).toBe('served')
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it.skipIf(process.platform !== 'win32' && symlinkUnsupportedReason() !== undefined)('does not route a redirected root to its new target', async () => {
    const fixture = createFixtureWorkspace('lsp-redirect')
    writeFileSync(join(fixture.outside, 'same.ts'), 'const value = 1\n')
    const { ctx } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      writeFileSync(join(fixture.base, 'elsewhere.ts'), '')
      const other = join(fixture.base, 'other-target')
      mkdirSync(other)
      writeFileSync(join(other, 'same.ts'), 'const sneaky = 1\n')
      renameSync(fixture.outside, join(fixture.base, 'saved'))
      symlinkSync(other, fixture.outside, process.platform === 'win32' ? 'junction' : 'dir')
      // The scope reports redirected and withholds the grant: the old path must
      // not be routed to the replacement directory's server.
      await expect(ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'same.ts'), operation: 'hover', position: { line: 0, character: 0 } }))
        .rejects.toThrow('outside the workspace')
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it('restores the upstream query when the routing fiber unloads with servers alive', async () => {
    const fixture = createFixtureWorkspace('lsp-unload')
    writeFileSync(join(fixture.workspace, 'same.ts'), 'const value = 1\n')
    const { ctx, fiber } = await mountLsp(fixture)
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: 'same.ts', operation: 'hover', position: { line: 0, character: 0 } })
      await fiber.dispose()
      expect(Object.getOwnPropertyDescriptor(ctx.lsp, 'query')).toBeUndefined()
      const result = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: 'same.ts', operation: 'hover', position: { line: 0, character: 0 } })
      expect(hoverOf(result).cwd).toBe(canonicalPath(fixture.workspace))
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it.runIf(process.platform === 'win32')('routes case-variant and second-drive roots to the same servers', async (context) => {
    const fixture = createFixtureWorkspace('lsp-win32')
    const { ctx } = await mountLsp(fixture)
    let crossDrive: string | undefined
    try {
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      writeFileSync(join(fixture.outside, 'same.ts'), 'const value = 1\n')
      const canonical = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'same.ts'), operation: 'hover', position: { line: 0, character: 0 } })
      const variant = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(fixture.outside, 'SAME.TS').toUpperCase(), operation: 'hover', position: { line: 0, character: 0 } })
      expect(hoverOf(variant).pid).toBe(hoverOf(canonical).pid)
      // A second writable fixed drive hosts another additional root.
      const fixtureDrive = canonicalPath(fixture.workspace).slice(0, 2).toUpperCase()
      for (const letter of ['D:', 'C:']) {
        if (`${letter}\\`.toUpperCase() === fixtureDrive) continue
        try {
          crossDrive = mkdtempSync(join(`${letter}\\`, 'dsh-mr-xdrive-'))
          break
        } catch { continue }
      }
      if (crossDrive === undefined) {
        if (process.env.CI !== undefined) expect.unreachable('CI runners have a second fixed drive (C: and D:)')
        context.skip('no second writable fixed drive found')
        return
      }
      writeFileSync(join(crossDrive, 'same.ts'), 'const value = 1\n')
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
        { id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) },
        { id: 'drive', path: crossDrive, recordedPath: canonicalPath(crossDrive) },
      ])
      const other = await ctx.lsp.query({ workspaceRoot: fixture.workspace, filePath: join(crossDrive, 'same.ts'), operation: 'hover', position: { line: 0, character: 0 } })
      expect(hoverOf(other).rootUri).toBe(pathToFileURL(canonicalPath(crossDrive)).href)
      expect(hoverOf(other).pid).not.toBe(hoverOf(canonical).pid)
    } finally {
      await ctx.fiber.dispose()
      if (crossDrive !== undefined) rmSync(crossDrive, { recursive: true, force: true })
      fixture.dispose()
    }
  })
})

