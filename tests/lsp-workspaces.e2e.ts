import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Lsp } from '@deepseek-ai/dsh-lsp'
import * as LspStdio from '@deepseek-ai/dsh-lsp-stdio'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { expect, it } from 'vitest'
import MultiRootScope from '../src/scope.ts'
import * as Routing from '../src/lsp.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace, REPO_ROOT } from './support/temp-workspace.ts'

it('initializes and pools real stdio servers independently for the primary and additional roots', async () => {
  const fixture = createFixtureWorkspace('lsp-stdio')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Lsp)
    await ctx.plugin(MultiRootScope)
    await mountCompat(ctx)
    await ctx.plugin(Routing)
    await ctx.plugin(LspStdio, { servers: { fixture: { command: process.execPath, args: [join(REPO_ROOT, 'tests/support/lsp-server.mjs')], extensionToLanguage: { '.ts': 'typescript' } } } })
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
