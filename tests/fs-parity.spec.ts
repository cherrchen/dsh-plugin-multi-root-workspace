/**
 * Differential parity suite: `MultiRootFileSystem` must behave EXACTLY like the
 * upstream `SandboxedFileSystem` when the scope carries no additional roots.
 *
 * This is the M1 safety net. Each backend runs the same operation table on its
 * OWN fixture tree (so no run can observe the other's writes), and the recorded
 * outcomes are compared after normalizing the fixture paths away: success,
 * denial code, denial text, and what actually landed on disk. Any divergence
 * with zero additional roots is a defect in this plugin, not a design choice.
 *
 * The suite also pins the multi-root extension itself: an additional root
 * becomes writable, an unrelated sibling stays denied, and `read-only` still
 * denies everything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import { symlinkUnsupportedReason } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

const fixtures: FixtureWorkspace[] = []
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixtures.length = 0
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  for (const fixture of fixtures) {
    await rm(join(tmpdir(), `dsh-mr-parity-${basename(fixture.base)}.txt`), { force: true })
    fixture.dispose()
  }
  fixtures.length = 0
})

interface Backend {
  ctx: Context
  fs: FileSystem
  fixture: FixtureWorkspace
}

async function mount(plugin: unknown, fixture: FixtureWorkspace, mode: SandboxMode, roots: readonly string[]): Promise<Backend> {
  fixtures.push(fixture)
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
  )
  if (plugin === MultiRootFileSystem) {
    fibers.push(await ctx.plugin(MultiRootScopeService))
    await mountCompat(ctx)
  }
  fibers.push(await ctx.plugin(plugin as never, { cwd: fixture.workspace }))
  if (plugin === MultiRootFileSystem) {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, roots.map((path, index) => ({ id: `root-${index}`, path, recordedPath: canonicalPath(path) })))
  }
  return { ctx, fs: ctx.fs, fixture }
}

/** Resolve a path through a backend the way the tool layer does. */
function target(backend: Backend, path: string): Promise<FsTarget> {
  return backend.fs.resolve(path)
}

/**
 * Run one mutation and describe its outcome in a comparable form: the error
 * code and message for a denial, otherwise `ok` plus the on-disk content.
 */
async function outcome(run: () => Promise<unknown>, path: string): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FsError)
    const failure = error as FsError & { code?: string }
    return `denied ${failure.code ?? 'NO_CODE'}: ${failure.message}`
  }
  return existsSync(path) ? `ok: ${await readFile(path, 'utf8')}` : 'ok: no file'
}

type Case = {
  name: string
  run: (backend: Backend) => Promise<string>
  /** Why this case cannot run here; it is then recorded as skipped for BOTH backends. */
  skip?: string
}

function mutationCases(mode: SandboxMode): Case[] {
  void mode
  return [
    {
      name: 'writes inside the primary root',
      run: async backend => {
        const path = join(backend.fixture.workspace, 'inside.txt')
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'writes into a nested directory of the primary root',
      run: async backend => {
        const path = join(backend.fixture.workspace, 'nested', 'deep.txt')
        await mkdir(join(backend.fixture.workspace, 'nested'), { recursive: true })
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'denies a sibling directory that shares a lexical prefix',
      run: async backend => {
        const path = join(backend.fixture.base, 'ws-child', 'x.txt')
        await mkdir(join(backend.fixture.base, 'ws-child'), { recursive: true })
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'denies an absolute path outside every root',
      run: async backend => {
        const path = join(backend.fixture.outside, 'outside.txt')
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'denies traversal out of the primary root',
      run: async backend => {
        const path = join(backend.fixture.workspace, '..', 'escaped.txt')
        const resolved = join(backend.fixture.base, 'escaped.txt')
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, resolved)
      },
    },
    {
      name: 'denies a write through a symlinked directory inside the root',
      skip: symlinkUnsupportedReason(),
      run: async backend => {
        await mkdir(join(backend.fixture.workspace, 'link'), { recursive: true })
        await symlink(backend.fixture.outside, join(backend.fixture.workspace, 'link', 'escape'), 'dir')
        const path = join(backend.fixture.workspace, 'link', 'escape', 'viasymlink.txt')
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'allows the platform temp area',
      run: async backend => {
        const path = join(tmpdir(), `dsh-mr-parity-${basename(backend.fixture.base)}.txt`)
        return await outcome(async () => {
          await backend.fs.writeText(await target(backend, path), 'payload')
        }, path)
      },
    },
    {
      name: 'edits a file inside the primary root',
      run: async backend => {
        const path = join(backend.fixture.workspace, 'edited.txt')
        await writeFile(path, 'before')
        return await outcome(async () => {
          await backend.fs.editText(await target(backend, path), { oldString: 'before', newString: 'after', replaceAll: false })
        }, path)
      },
    },
    {
      name: 'denies an edit outside every root',
      run: async backend => {
        const path = join(backend.fixture.outside, 'edited.txt')
        await writeFile(path, 'before')
        return await outcome(async () => {
          await backend.fs.editText(await target(backend, path), { oldString: 'before', newString: 'after', replaceAll: false })
        }, path)
      },
    },
    {
      name: 'resolves a relative path against the configured cwd',
      run: async backend => {
        const resolved = await backend.fs.resolve('relative.txt')
        return resolved.targetKey === join(backend.fixture.workspace, 'relative.txt')
          ? 'same-target'
          : `target: ${String(resolved.targetKey)}`
      },
    },
    {
      name: 'reads an outside file in every mode',
      run: async backend => {
        const path = join(backend.fixture.outside, 'readable.txt')
        await writeFile(path, 'visible')
        return await backend.fs.readText(await target(backend, path))
      },
    },
  ]
}

/** Record every case's outcome for one backend, with fixture paths normalized. */
async function record(backend: Backend, cases: readonly Case[]): Promise<Map<string, string>> {
  const recorded = new Map<string, string>()
  for (const entry of cases) {
    // A case this host cannot set up is skipped for both backends at once, so the
    // comparison keeps its meaning instead of comparing a failure with a pass.
    const raw = entry.skip === undefined ? await entry.run(backend) : `skipped: ${entry.skip}`
    recorded.set(entry.name, raw
      .replaceAll(backend.fixture.base, '<base>')
      .replaceAll(basename(backend.fixture.base), '<base>'))
  }
  return recorded
}

async function runParity(mode: SandboxMode): Promise<void> {
  const upstream = await mount(SandboxedFileSystem, createFixtureWorkspace('fs-parity-up'), mode, [])
  const ours = await mount(MultiRootFileSystem, createFixtureWorkspace('fs-parity-ours'), mode, [])
  expect(ours.fs.sandboxMode).toBe(upstream.fs.sandboxMode)

  const cases = mutationCases(mode)
  const upstreamOutcomes = await record(upstream, cases)
  const ourOutcomes = await record(ours, cases)
  for (const entry of cases) {
    expect(ourOutcomes.get(entry.name), entry.name).toBe(upstreamOutcomes.get(entry.name))
  }
}

describe('parity with the upstream single-root fence (empty additional roots)', () => {
  it('workspace-write', async () => {
    await runParity('workspace-write')
  })

  it('read-only', async () => {
    await runParity('read-only')
  })

  it('danger-full-access', async () => {
    await runParity('danger-full-access')
  })
})

describe('multi-root extension', () => {
  it('makes an additional root writable while unrelated trees stay denied', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const fixture = createFixtureWorkspace('fs-multi')
    fixtures.push(fixture)
    const ours = await mount(MultiRootFileSystem, fixture, 'workspace-write', [fixture.outside])

    const granted = join(fixture.outside, 'granted.txt')
    await ours.fs.writeText(await target(ours, granted), 'granted')
    expect(await readFile(granted, 'utf8')).toBe('granted')

    const unrelated = join(fixture.base, 'third')
    await mkdir(unrelated, { recursive: true })
    await expect(ours.fs.writeText(await target(ours, join(unrelated, 'denied.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

    await mkdir(join(fixture.workspace, 'link'), { recursive: true })
    await symlink(unrelated, join(fixture.workspace, 'link', 'escape'), 'dir')
    await expect(ours.fs.writeText(await target(ours, join(fixture.workspace, 'link', 'escape', 'x.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('names every allowed root in the multi-root denial message', async () => {
    const fixture = createFixtureWorkspace('fs-denial')
    fixtures.push(fixture)
    const ours = await mount(MultiRootFileSystem, fixture, 'workspace-write', [fixture.outside])
    const unrelated = join(fixture.base, 'third')
    await mkdir(unrelated, { recursive: true })
    const failure = await ours.fs.writeText(await target(ours, join(unrelated, 'x.txt')), 'x')
      .then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toContain('allowed roots:')
    expect(failure?.message).toContain(fixture.workspace)
    expect(failure?.message).toContain(fixture.outside)
  })

  it('keeps read-only denying an additional root', async () => {
    const fixture = createFixtureWorkspace('fs-ro')
    fixtures.push(fixture)
    const ours = await mount(MultiRootFileSystem, fixture, 'read-only', [fixture.outside])
    await expect(ours.fs.writeText(await target(ours, join(fixture.outside, 'x.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('does not recreate an additional root deleted before the next registry refresh', async () => {
    const fixture = createFixtureWorkspace('fs-missing-live')
    fixtures.push(fixture)
    const ours = await mount(MultiRootFileSystem, fixture, 'workspace-write', [fixture.outside])
    await rm(fixture.outside, { recursive: true, force: true })

    await expect(ours.fs.writeText(await target(ours, join(fixture.outside, 'recreated.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(fixture.outside)).toBe(false)
  })
})

describe('configuration compatibility', () => {
  it('inherits the upstream config surface (cwd default and diff bound validation)', async () => {
    const fixture = createFixtureWorkspace('fs-config')
    const backend = await mount(MultiRootFileSystem, fixture, 'workspace-write', [])
    const configured = backend.fs as unknown as { config: { cwd: string; diffBasisMaxBytes: number } }
    expect(configured.config.cwd).toBe(fixture.workspace)
    expect(configured.config.diffBasisMaxBytes).toBeGreaterThan(0)

    const ctx = new Context()
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService),
    )
    await mountCompat(ctx)
    await expect(ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace, diffBasisMaxBytes: 0 })).rejects.toThrow()
  })
})
