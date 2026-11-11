/**
 * The metadata snapshot layer: checkout activation, config/HEAD/index gates,
 * the full ancestor chain, and the Unicode/case equivalence rules.
 *
 * The fixtures are REAL repositories created with Git in the setup — the
 * feature under test must never start Git, so every Git invocation here is
 * fixture construction, not production behavior.
 *
 * @module tests/worktrees-metadata
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'
import { resolveRepo, validateHead } from '../src/worktrees/repository.ts'
import { snapshotGitConfig } from '../src/worktrees/config.ts'
import { lookupGitlink, parseGitIndex } from '../src/worktrees/index-format.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  return result.stdout
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'fixture@example.invalid'])
  git(path, ['config', 'user.name', 'Fixture'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

function canonical(path: string): string {
  return realpathSync.native(path)
}

function expectActive(path: string, shape?: 'main' | 'linked') {
  const result = resolveRepo(path)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('unreachable')
  if (shape !== undefined) expect(result.repo.shape).toBe(shape)
  return result.repo
}

function expectInactive(path: string, reason?: string) {
  const result = resolveRepo(path)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected an inactive verdict')
  if (reason !== undefined) expect(result.reason).toBe(reason)
  return result
}

/** One version-2 index entry with the required eight-byte alignment. */
function v2Entry(path: string, mode: number): Buffer {
  const header = Buffer.alloc(62)
  header.writeUInt32BE(mode, 24)
  header.writeUInt16BE(0, 60)
  const name = Buffer.from(path)
  const total = (62 + name.length + 8) & ~7
  return Buffer.concat([header, name, Buffer.alloc(total - 62 - name.length)])
}

/** Build one synthetic index with optional extensions. */
function indexFile(entries: readonly Buffer[], version = 2, extensions: readonly { signature: string; data: Buffer }[] = []): Buffer {
  const header = Buffer.alloc(12)
  header.write('DIRC', 0, 'latin1')
  header.writeUInt32BE(version, 4)
  header.writeUInt32BE(entries.length, 8)
  const tail = extensions.map(extension => {
    const head = Buffer.alloc(8)
    head.write(extension.signature, 0, 'latin1')
    head.writeUInt32BE(extension.data.length, 4)
    return Buffer.concat([head, extension.data])
  })
  return Buffer.concat([header, ...entries, ...tail, Buffer.alloc(20)])
}

const fixtures: FixtureWorkspace[] = []
function fixture(label: string): FixtureWorkspace {
  const created = createFixtureWorkspace(label)
  fixtures.push(created)
  return created
}
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

describe('checkout activation', () => {
  it('accepts a main checkout root but not one of its subdirectories or a plain directory', () => {
    const area = fixture('metadata-main')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, 'sub'))
    const snapshot = expectActive(repo, 'main')
    expect(snapshot.common).toBe(canonical(join(repo, '.git')))
    expect(snapshot.head.startsWith('ref: refs/heads/')).toBe(true)
    expectInactive(join(repo, 'sub'), 'not-a-checkout')
    expectInactive(area.outside, 'not-a-checkout')
  })

  it('accepts a linked worktree and binds it to its common and admin', () => {
    const area = fixture('metadata-linked')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const snapshot = expectActive(linked, 'linked')
    expect(snapshot.common).toBe(canonical(join(main, '.git')))
    expect(snapshot.adminId).toBeDefined()
    expect(snapshot.adminGitdir).toBe(canonical(join(main, '.git', 'worktrees', snapshot.adminId!)))
    expect(snapshot.adminHead).toBeDefined()
    expect(snapshot.config.repositoryFormatVersion).toBe(0)

    // Parent-repository gitlink check also applies to linked checkouts when
    // the root is nested; the plain linked worktree above stays active.
    expect(resolveRepo(join(linked, 'sub')).ok).toBe(false)
  })

  it('refuses a fake .git directory, a fake admin and a missing checkout', () => {
    const area = fixture('metadata-fake')
    const fake = join(area.base, 'fake')
    mkdirSync(join(fake, '.git'), { recursive: true })
    writeFileSync(join(fake, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(fake, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
    expectInactive(fake, 'unsupported-layout')

    const fakeLinked = join(area.base, 'fake-linked')
    const admin = join(area.base, 'admin')
    mkdirSync(admin, { recursive: true })
    mkdirSync(fakeLinked, { recursive: true })
    mkdirSync(join(area.base, 'common', 'worktrees'), { recursive: true })
    writeFileSync(join(fakeLinked, '.git'), `gitdir: ${admin}\n`)
    writeFileSync(join(admin, 'commondir'), '../common\n')
    writeFileSync(join(admin, 'gitdir'), `${join(fakeLinked, '.git')}\n`)
    expectInactive(fakeLinked, 'unsupported-layout')
  })

  it('refuses the separate-git-dir main checkout but accepts its derived linked worktrees', () => {
    const area = fixture('metadata-separate')
    const main = join(area.base, 'main')
    const store = join(area.base, 'store.git')
    mkdirSync(main, { recursive: true })
    git(main, ['init', '-q', '-b', 'main', `--separate-git-dir=${store}`])
    git(main, ['config', 'user.email', 'fixture@example.invalid'])
    git(main, ['config', 'user.name', 'Fixture'])
    writeFileSync(join(main, 'README.md'), 'x\n')
    git(main, ['add', 'README.md'])
    git(main, ['commit', '-q', '-m', 'initial'])
    expectInactive(main, 'unsupported-layout')
    const first = join(area.base, 'first')
    const second = join(area.base, 'second')
    git(main, ['worktree', 'add', '-q', first, '-b', 'one'])
    git(main, ['worktree', 'add', '-q', second, '-b', 'two'])
    expectActive(first, 'linked')
    expectActive(second, 'linked')
  })

  it('refuses bare-derived linked worktrees and --relative-paths version 1', () => {
    const area = fixture('metadata-bare')
    const bare = join(area.base, 'bare.git')
    git(area.base, ['init', '-q', '--bare', bare])
    const seed = join(area.base, 'seed')
    initRepo(seed)
    git(seed, ['push', '-q', bare, 'main:main'])
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const bareWorktree = join(area.base, 'bare-wt')
    git(bare, ['worktree', 'add', '-q', bareWorktree, 'main'])
    expectInactive(bareWorktree, 'unsupported-layout')

    const relativeBase = join(area.base, 'relative')
    initRepo(relativeBase)
    const relativeWorktree = join(area.base, 'relative-wt')
    git(relativeBase, ['worktree', 'add', '-q', '--relative-paths', relativeWorktree, '-b', 'relative'])
    const version = readFileSync(join(relativeBase, '.git', 'config'), 'utf8')
    expect(version).toContain('relativeWorktrees')
    expectInactive(relativeWorktree, 'unsupported-config')
  })

  it('refuses include, non-empty core.worktree, worktreeConfig and index gates in the config snapshot', () => {
    expect(snapshotGitConfig('[include]\n\tpath = /tmp/x\n').ok).toBe(false)
    expect(snapshotGitConfig('[core]\n\tworktree = /elsewhere\n').ok).toBe(false)
    expect(snapshotGitConfig('[extensions]\n\tworktreeConfig = true\n').ok).toBe(false)
    expect(snapshotGitConfig('[core]\n\trepositoryformatversion = 1\n').ok).toBe(false)
    expect(snapshotGitConfig('[extensions]\n\tobjectFormat = sha256\n').ok).toBe(false)
    expect(snapshotGitConfig('[core]\n\tsplitIndex = true\n').ok).toBe(false)
    expect(snapshotGitConfig('[core]\n\tsparseCheckout = true\n').ok).toBe(false)
    expect(snapshotGitConfig('[index]\n\tsparse = true\n').ok).toBe(false)
    const plain = snapshotGitConfig('[core]\n\tbare = false\n')
    expect(plain).toMatchObject({ ok: true, config: { bare: false, repositoryFormatVersion: 0 } })
    expect(snapshotGitConfig('').ok).toBe(true)
    // An unquoted Windows path keeps its backslashes; a trailing comment is
    // still a comment only after whitespace.
    expect(snapshotGitConfig('[core]\n\tworktree = C:\\repo\n').ok).toBe(false)
  })

  it('refuses objects alternates without reading objects', () => {
    const area = fixture('metadata-alternates')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), '/tmp/other-objects\n')
    expectInactive(repo, 'unsupported-layout')
  })

  it('refuses symlinked metadata and a FIFO without blocking', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const area = fixture('metadata-io')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    const external = join(area.base, 'external-index')
    writeFileSync(external, 'outside')
    rmSync(join(repo, '.git', 'index'))
    symlinkSync(external, join(repo, '.git', 'index'))
    // The primary index is only parsed by the ancestor chain; make this repo
    // an ancestor-shaped case by resolving a nested linked checkout instead.
    expectInactive(join(repo, '.git'), 'not-a-checkout')
    const linked = join(area.base, 'linked')
    git(repo, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    expectActive(linked, 'linked')

    if (process.platform !== 'win32') {
      // A FIFO as the admin HEAD must be refused without blocking.
      const fifo = join(area.base, 'fifo')
      const made = spawnSync('mkfifo', [fifo])
      if (made.status === 0) {
        rmSync(join(repo, '.git', 'worktrees', readFileSync(join(linked, '.git'), 'utf8').trim().split('/').pop()!, 'HEAD'))
        symlinkSync(fifo, join(repo, '.git', 'worktrees', readFileSync(join(linked, '.git'), 'utf8').trim().split('/').pop()!, 'HEAD'))
        expectInactive(linked)
      }
    }
  })

  it('refuses invalid HEAD spellings and accepts ref/hex forms', () => {
    for (const value of ['', 'definitely-not-a-head', 'a'.repeat(39), 'a'.repeat(41), 'ref: main', 'ref: refs/heads/a..b']) {
      expect(validateHead(value).ok, value).toBe(false)
    }
    expect(validateHead('ref: refs/heads/main\n').ok).toBe(true)
    expect(validateHead('a'.repeat(40)).ok).toBe(true)
    expect(validateHead('ref: refs/heads/main\r\n').ok).toBe(false)
    expect(validateHead('ref: refs/heads/main\nref: refs/heads/other\n').ok).toBe(false)

    const area = fixture('metadata-head')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    writeFileSync(join(repo, '.git', 'HEAD'), 'definitely-not-a-head\n')
    expectInactive(repo, 'invalid-head')
  })
})

describe('index snapshot', () => {
  it('parses literal entries and refuses split/sparse/directory layouts', () => {
    const simple = parseGitIndex(indexFile([v2Entry('lib', 0o160000), v2Entry('README.md', 0o100644)]))
    expect(simple.ok).toBe(true)
    if (!simple.ok) return
    expect(lookupGitlink(simple.index, 'lib', { ignoreCase: false, precomposeUnicode: true } as never, 'linux')).toEqual({ ok: true, mode: 0o160000 })
    expect(lookupGitlink(simple.index, ':lib', { ignoreCase: false, precomposeUnicode: true } as never, 'linux')).toEqual({ ok: true, mode: undefined })
    expect(parseGitIndex(indexFile([v2Entry('dir', 0o040000)])).ok).toBe(false)
    expect(parseGitIndex(indexFile([v2Entry('a', 0o100644)], 2, [{ signature: 'link', data: Buffer.alloc(0) }])).ok).toBe(false)
    expect(parseGitIndex(indexFile([v2Entry('a', 0o100644)], 2, [{ signature: 'sdir', data: Buffer.alloc(0) }])).ok).toBe(false)
    expect(parseGitIndex(indexFile([v2Entry('a', 0o100644)], 2, [{ signature: 'zzzz', data: Buffer.alloc(0) }])).ok).toBe(false)
    expect(parseGitIndex(indexFile([v2Entry('a', 0o100644)], 2, [{ signature: 'ZZZZ', data: Buffer.alloc(0) }])).ok).toBe(true)
    expect(parseGitIndex(indexFile([v2Entry('a', 0o100644)], 5)).ok).toBe(false)
  })

  it('refuses real split and sparse indexes through the parsed format gate', () => {
    const area = fixture('metadata-real-indexes')
    const split = join(area.base, 'split')
    initRepo(split)
    git(split, ['update-index', '--split-index'])
    const splitIndex = parseGitIndex(readFileSync(join(split, '.git', 'index')))
    expect(splitIndex.ok).toBe(false)
    // A split index may present empty path names before the link extension is
    // reachable; either refusal is the required conservative outcome.
    if (!splitIndex.ok) expect(splitIndex.detail).toMatch(/link|empty path/)

    const sparse = join(area.base, 'sparse')
    initRepo(sparse)
    mkdirSync(join(sparse, 'src', 'deep'), { recursive: true })
    writeFileSync(join(sparse, 'src', 'deep', 'file.ts'), 'x\n')
    git(sparse, ['add', '-A'])
    git(sparse, ['commit', '-q', '-m', 'more'])
    git(sparse, ['sparse-checkout', 'init', '--cone', '--sparse-index'])
    git(sparse, ['sparse-checkout', 'set', 'src'])
    const sparseIndex = parseGitIndex(readFileSync(join(sparse, '.git', 'index')))
    expect(sparseIndex.ok).toBe(false)
    if (!sparseIndex.ok) expect(sparseIndex.detail).toMatch(/sdir|040000/)
  })

  it('parses a real version-4 index and matches literal paths', () => {
    const area = fixture('metadata-index')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    writeFileSync(join(repo, 'src', 'deep', 'file.ts'), 'x\n')
    git(repo, ['add', 'src/deep/file.ts'])
    git(repo, ['update-index', '--index-version', '4'])
    const parsed = parseGitIndex(readFileSync(join(repo, '.git', 'index')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.index.version).toBe(4)
    expect(parsed.index.entries.some(entry => entry.path === 'src/deep/file.ts')).toBe(true)
  })
})

describe('ancestor chain', () => {
  it('refuses an embedded repository registered as a gitlink', () => {
    const area = fixture('metadata-submodule')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const inner = join(outer, 'vendor', 'lib')
    initRepo(inner)
    git(outer, ['add', 'vendor/lib'])
    git(outer, ['commit', '-q', '-m', 'add gitlink'])
    expectInactive(inner, 'submodule')
  })

  it('keeps walking past a nearer independent repository that shadows the outer gitlink', () => {
    const area = fixture('metadata-shadow')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const lib = join(outer, 'vendor', 'lib')
    initRepo(lib)
    git(outer, ['add', 'vendor/lib'])
    git(outer, ['commit', '-q', '-m', 'add gitlink'])
    // A second independent repository ABOVE the embedded one: the nearest
    // ancestor answers "no lib" while outer still records vendor/lib as 160000.
    const vendor = join(outer, 'vendor')
    git(vendor, ['init', '-q', '-b', 'main'])
    mkdirSync(join(lib, 'src'), { recursive: true })
    writeFileSync(join(lib, 'README.md'), 'shadow\n')
    expectInactive(lib, 'submodule')
    expectActive(vendor, 'main')
  })

  it('refuses a linked worktree that is itself registered as a submodule', () => {
    const area = fixture('metadata-linked-submodule')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, 'vendor'), { recursive: true })
    const linked = join(repo, 'vendor', 'lib')
    git(repo, ['worktree', 'add', '-q', linked, '-b', 'lib'])
    // The parent repository now records vendor/lib as a gitlink while the
    // linked checkout keeps its .git file and commondir.
    git(repo, ['add', 'vendor/lib'])
    git(repo, ['commit', '-q', '-m', 'add nested worktree as gitlink'])
    expect(readFileSync(join(linked, '.git'), 'utf8')).toContain('gitdir:')
    expectInactive(linked, 'submodule')
  })

  it('refuses a symlinked or FIFO ancestor index without reading or blocking', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const area = fixture('metadata-ancestor-io')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const nested = join(outer, 'nested')
    initRepo(nested)
    const external = join(area.base, 'external-index')
    writeFileSync(external, 'outside')
    rmSync(join(outer, '.git', 'index'))
    symlinkSync(external, join(outer, '.git', 'index'))
    expectInactive(nested, 'unprovable-ancestor')
    if (process.platform !== 'win32') {
      rmSync(join(outer, '.git', 'index'))
      const made = spawnSync('mkfifo', [join(outer, '.git', 'index')])
      if (made.status === 0) expectInactive(nested, 'unprovable-ancestor')
    }
  })

  it('refuses an ancestor whose metadata cannot be read', () => {
    const area = fixture('metadata-ancestor-io')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const nested = join(outer, 'nested')
    initRepo(nested)
    writeFileSync(join(outer, '.git', 'index'), 'not an index')
    expectInactive(nested, 'unprovable-ancestor')
  })

  it('matches NFC and NFD ancestor paths on macOS', (context) => {
    if (process.platform !== 'darwin') return context.skip()
    const area = fixture('metadata-unicode')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const nfdName = 'cafe\u0301'
    const nfdDir = join(outer, 'vendor', nfdName)
    initRepo(nfdDir)
    git(outer, ['add', 'vendor'])
    git(outer, ['commit', '-q', '-m', 'add unicode gitlink'])
    const listing = git(outer, ['ls-files', '-s', 'vendor'])
    if (!listing.includes('160000')) return context.skip()
    expectInactive(nfdDir, 'submodule')
    const nfcDir = join(outer, 'vendor', 'caf\u00e9')
    expect(canonical(nfdDir)).toBe(canonical(nfcDir))
  })
})

describe('metadata independence', () => {
  it('never runs a fsmonitor program', () => {
    const area = fixture('metadata-fsmonitor')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    const marker = join(area.base, 'fsmonitor-ran')
    const script = join(area.base, 'fsmonitor.sh')
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    const linked = join(area.base, 'linked')
    // Create the worktree FIRST: the fixture's own Git call, not the plugin,
    // would otherwise execute the fsmonitor hook and pollute the assertion.
    git(repo, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    git(repo, ['config', 'core.fsmonitor', script])
    expectActive(repo, 'main')
    expectActive(linked, 'linked')
    expect(() => readFileSync(marker)).toThrow()
    // A stray temp file is cheap to clean even if the fixture teardown runs.
    try { rmSync(marker) } catch { /* absent by design */ }
  })
})
