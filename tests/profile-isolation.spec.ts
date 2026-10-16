/**
 * `/workspace-folders isolate-profiles` — the Phase C2 maintenance module.
 *
 * The suite pins two halves: the strict `pnpm-workspace.yaml` subset scanner
 * (which fails closed on every construct it cannot interpret, because the
 * runtime may not depend on a YAML parser) and the report/apply pair that
 * touches only confirmed profiles — reparse points, non-profile directories,
 * and conflicted files are enumerated and never written.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import {
  applyIsolateConfig,
  isolateReport,
  parseWorkspaceYamlKeys,
  PROFILE_PNPM_WORKSPACE,
  remediationSteps,
} from '../src/profile-isolation.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let home: string

beforeEach(() => {
  fixture = createFixtureWorkspace('isolate')
  home = join(fixture.base, 'dsh-home')
  mkdirSync(join(home, 'profiles'), { recursive: true })
})

afterEach(() => fixture.dispose())

/** Create `<home>/profiles/<name>` with a manifest and optional yaml text. */
function makeProfile(name: string, options: {
  manifest?: string | object
  yaml?: string
  withModules?: boolean
} = {}): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  const manifest = options.manifest ?? { name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
  if (options.yaml !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), options.yaml)
  if (options.withModules === true) {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'dep')
  }
  return dir
}

describe('parseWorkspaceYamlKeys', () => {
  it('reports same-line scalars with their offsets, and ends values before ` #` comments', () => {
    const entries = parseWorkspaceYamlKeys(
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false # keep this\npackageImportMethod: clone\n',
      'ws.yaml',
    )
    expect(entries.get('packages')).toMatchObject({ kind: 'block', line: 1 })
    expect(entries.get('nodeLinker')).toMatchObject({ kind: 'scalar', value: 'hoisted', line: 4 })
    const peers = entries.get('autoInstallPeers')
    expect(peers).toMatchObject({ kind: 'scalar', value: 'false', line: 5 })
    expect(entries.get('packageImportMethod')).toMatchObject({ kind: 'scalar', value: 'clone' })
    expect(entries.has('packages')).toBe(true)
    expect(peers).toBeDefined()
  })

  it('unquotes single- and double-quoted keys and values', () => {
    const entries = parseWorkspaceYamlKeys(`'k.e-y': 'it''s'\n"weird": "tab\\there"\n`)
    expect(entries.get('k.e-y')).toMatchObject({ kind: 'scalar', value: "it's" })
    expect(entries.get('weird')).toMatchObject({ kind: 'scalar', value: 'tab\there' })
  })

  it('marks anchors, aliases, tags, block scalars, and flow values complex — never scalars', () => {
    const entries = parseWorkspaceYamlKeys('a: &anchor 1\nb: *anchor\nc: !typed\nd: |\ne: >\nf: {k: v}\ng: [1, 2]\n')
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(entries.get(key)?.kind, key).toBe('complex')
    }
  })

  it('treats an empty value as a block and a bare `#` tail as empty', () => {
    const entries = parseWorkspaceYamlKeys('a:\nb:   \nc: # a comment only\n')
    expect(entries.get('a')?.kind).toBe('block')
    expect(entries.get('b')?.kind).toBe('block')
    expect(entries.get('c')?.kind).toBe('block')
  })

  it('rejects directives, document markers, duplicate keys, tabs, and non-key lines — naming file and line', () => {
    const bad: [string, RegExp][] = [
      ['%YAML 1.2\nk: v\n', /ws\.yaml:1.*directive/],
      ['---\nk: v\n', /ws\.yaml:1.*---/],
      ['k: v\n...\n', /ws\.yaml:2.*\.\.\./],
      ['k: 1\nk: 2\n', /ws\.yaml:2.*duplicate top-level key "k"/],
      ['k: 1\n\'k\': 2\n', /duplicate top-level key/],
      ['\tk: v\n', /ws\.yaml:1.*tab in indentation/],
      ['  \tk: v\n', /tab in indentation/],
      ['just words\n', /ws\.yaml:1/],
      ['- item\n', /ws\.yaml:1/],
      ['key: v\n  nested: deep\nstray words\n', /ws\.yaml:3/],
    ]
    for (const [text, pattern] of bad) {
      expect(() => parseWorkspaceYamlKeys(text, 'ws.yaml'), JSON.stringify(text)).toThrowError(pattern)
    }
    // A tab AFTER the colon is separation whitespace, not indentation.
    expect(parseWorkspaceYamlKeys('k:\tv\n').get('k')?.value).toBe('v')
  })

  it('spans the scalar token only — a range edit preserves comments and CRLF', () => {
    const text = 'first: 1\r\npackageImportMethod: clone   # trailing note\r\nlast: yes\r\n'
    const entry = parseWorkspaceYamlKeys(text).get('packageImportMethod')!
    expect(entry.kind).toBe('scalar')
    const replaced = text.slice(0, entry.valueStart) + 'copy' + text.slice(entry.valueEnd)
    expect(replaced).toBe('first: 1\r\npackageImportMethod: copy   # trailing note\r\nlast: yes\r\n')
  })

  it('spans quoted scalars including their quotes so replacement drops them', () => {
    const text = 'packageImportMethod: "clone" # note\n'
    const entry = parseWorkspaceYamlKeys(text).get('packageImportMethod')!
    expect(entry).toMatchObject({ kind: 'scalar', value: 'clone' })
    expect(text.slice(0, entry.valueStart) + 'copy' + text.slice(entry.valueEnd)).toBe('packageImportMethod: copy # note\n')
  })

  it('marks an unterminated quote complex instead of inventing a scalar', () => {
    const entries = parseWorkspaceYamlKeys(`a: 'open\n`)
    expect(entries.get('a')?.kind).toBe('complex')
  })
})

describe('profile identification', () => {
  it('counts only directories whose package.json carries dsh.profile as an object', () => {
    const profile = makeProfile('real')
    const shapes: [string, string | object][] = [
      ['no-dsh', { name: 'x' }],
      ['dsh-no-profile', { dsh: {} }],
      ['profile-string', { dsh: { profile: 'main' } }],
      ['profile-null', { dsh: { profile: null } }],
      ['profile-array', { dsh: { profile: ['x'] } }],
      ['manifest-array', ['not', 'an', 'object']],
      ['corrupt', '{not json'],
      ['manifest-string', '"just a string"'],
    ]
    for (const [name, manifest] of shapes) makeProfile(name, { manifest })
    // A directory without package.json at all.
    mkdirSync(join(home, 'profiles', 'empty-dir'))
    // A plain file under profiles/ is not even a directory.
    writeFileSync(join(home, 'profiles', 'loose-file.txt'), 'x')

    const report = isolateReport(home)
    expect(report.profiles.map(p => p.name)).toEqual(['real'])
    expect(report.profiles[0]?.path).toBe(profile)
    // Eight manifest rejects + empty-dir + the stray file = 10 skipped entries.
    expect(report.nonProfileEntries).toHaveLength(10)
    expect(report.incomplete).toBe(false)
  })

  it('refuses when the home itself is a reparse point, and skips reparse entries under profiles/', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return // this host cannot create directory links
    const profile = makeProfile('real')
    const outside = join(fixture.base, 'elsewhere')
    mkdirSync(outside)
    symlinkSync(outside, join(home, 'profiles', 'linked'), 'junction')
    const report = isolateReport(home)
    expect(report.profiles.map(p => p.name)).toEqual(['real'])
    expect(report.nonProfileEntries).toContain(join(home, 'profiles', 'linked'))

    const linkedHome = join(fixture.base, 'linked-home')
    symlinkSync(home, linkedHome, 'junction')
    expect(() => isolateReport(linkedHome)).toThrowError(/reparse point/)
    void profile
  })

  it('classifies the yaml states', () => {
    makeProfile('no-file')
    makeProfile('no-key', { yaml: 'packages:\n  - .\n' })
    makeProfile('copied', { yaml: 'packageImportMethod: copy\n' })
    makeProfile('quoted-copy', { yaml: `packageImportMethod: 'copy' # ok\n` })
    makeProfile('other-scalar', { yaml: 'packageImportMethod: clone-or-copy\n' })
    makeProfile('anchored', { yaml: 'packageImportMethod: &m copy\n' })
    makeProfile('damaged', { yaml: 'dup: 1\ndup: 2\n' })
    const report = isolateReport(home)
    const byName = new Map(report.profiles.map(p => [p.name, p.yaml]))
    expect(byName.get('no-file')).toEqual({ state: 'absent' })
    expect(byName.get('no-key')).toEqual({ state: 'absent' })
    expect(byName.get('copied')).toEqual({ state: 'copy' })
    expect(byName.get('quoted-copy')).toEqual({ state: 'copy' })
    expect(byName.get('other-scalar')).toMatchObject({ state: 'conflict', detail: expect.stringContaining('clone-or-copy') })
    expect(byName.get('anchored')).toMatchObject({ state: 'conflict', detail: expect.stringContaining('block or complex') })
    expect(byName.get('damaged')).toMatchObject({ state: 'unreadable', detail: expect.stringContaining('duplicate top-level key') })
  })
})

describe('the home scan', () => {
  it.runIf(process.platform === 'win32')('counts every multi-link file under the home, not only inside profiles', () => {
    const profile = makeProfile('real')
    const storeDir = join(home, 'store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'blob.txt'), 'shared')
    linkSync(join(storeDir, 'blob.txt'), join(profile, 'linked.txt'))
    const report = isolateReport(home)
    expect(report.scan.multiLinkTotal).toBe(2)
    expect(report.scan.multiLinkPaths.sort()).toEqual(
      [join(profile, 'linked.txt'), join(storeDir, 'blob.txt')].map(p => canonicalPath(p)).sort(),
    )
    expect(report.incomplete).toBe(false)
    expect(report.scan.directories).toBeGreaterThan(0)
    expect(report.scan.files).toBeGreaterThan(0)
  })

  it.runIf(process.platform === 'win32')('an uninspectable subtree makes the report incomplete — never clean', () => {
    makeProfile('real')
    const locked = join(home, 'locked-dir')
    mkdirSync(locked)
    writeFileSync(join(locked, 'inner.txt'), 'x')
    const systemTool = (name: string): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${name}.exe`)
    const userSid = execFileSync(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
      .match(/S-1-\d+(?:-\d+)+/)?.[0]
    expect(userSid, 'the fixture needs the caller SID to deny itself read').not.toBeUndefined()
    // Deny listing on the subtree: readdir fails, the scan records it.
    const deny = spawnSync(systemTool('icacls'), [locked, '/deny', `*${userSid}:(RD)`], { encoding: 'utf8', timeout: 60_000 })
    expect(deny.status, deny.stderr).toBe(0)
    try {
      const report = isolateReport(home)
      expect(report.incomplete).toBe(true)
      expect(report.scan.uninspectableTotal).toBeGreaterThan(0)
      expect(report.scan.uninspectable[0]?.path).toBe(canonicalPath(locked))
    } finally {
      spawnSync(systemTool('icacls'), [locked, '/remove:d', `*${userSid}`], { encoding: 'utf8', timeout: 60_000 })
    }
  })
})

describe('applyIsolateConfig', () => {
  it('writes the upstream template plus copy for a profile without a yaml', () => {
    const profile = makeProfile('fresh')
    const report = applyIsolateConfig(home)
    expect(report.actions).toEqual([{ name: 'fresh', action: 'written', detail: 'packageImportMethod: copy' }])
    const written = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    expect(written).toBe(`${PROFILE_PNPM_WORKSPACE}packageImportMethod: copy\n`)
    expect(isolateReport(home).profiles[0]?.yaml.state).toBe('copy')
  })

  it('appends the key to a yaml that lacks it, preserving the existing text', () => {
    const profile = makeProfile('partial', { yaml: 'packages:\r\n  - .\r\n\r\nnodeLinker: hoisted\r\n' })
    const report = applyIsolateConfig(home)
    expect(report.actions[0]).toMatchObject({ name: 'partial', action: 'written' })
    expect(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe('packages:\r\n  - .\r\n\r\nnodeLinker: hoisted\r\npackageImportMethod: copy\n')
  })

  it('replaces only the scalar token of a non-copy value — comments and CRLF survive', () => {
    const profile = makeProfile('flavored', { yaml: 'packageImportMethod: clone   # hand note\r\nother: 1\r\n' })
    const report = applyIsolateConfig(home)
    expect(report.actions[0]).toMatchObject({ action: 'replaced' })
    const text = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    expect(text).toBe('packageImportMethod: copy   # hand note\r\nother: 1\r\n')
    expect(isolateReport(home).profiles[0]?.yaml.state).toBe('copy')
  })

  it('is a noop for a profile already importing copies', () => {
    const profile = makeProfile('done', { yaml: 'packageImportMethod: copy\n' })
    const before = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    const report = applyIsolateConfig(home)
    expect(report.actions[0]).toMatchObject({ action: 'noop' })
    expect(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toBe(before)
  })

  it('refuses complex values, damaged yaml, and non-profile directories — and changes nothing', () => {
    const anchored = makeProfile('anchored', { yaml: 'packageImportMethod: &m copy\n' })
    const damaged = makeProfile('damaged', { yaml: 'dup: 1\ndup: 2\n' })
    mkdirSync(join(home, 'profiles', 'stray')) // not a profile at all
    const report = applyIsolateConfig(home)
    const actions = new Map(report.actions.map(a => [a.name, a.action]))
    expect(actions.get('anchored')).toBe('refused')
    expect(actions.get('damaged')).toBe('refused')
    expect(readFileSync(join(anchored, 'pnpm-workspace.yaml'), 'utf8')).toBe('packageImportMethod: &m copy\n')
    expect(readFileSync(join(damaged, 'pnpm-workspace.yaml'), 'utf8')).toBe('dup: 1\ndup: 2\n')
    expect(existsSync(join(home, 'profiles', 'stray', 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('refuses to write through a yaml that is itself a reparse point', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const profile = makeProfile('linked', { yaml: 'packages:\n  - .\n' })
    const realYaml = join(fixture.base, 'real.yaml')
    writeFileSync(realYaml, 'packages:\n  - .\n')
    const yamlPath = join(profile, 'pnpm-workspace.yaml')
    rmSync(yamlPath)
    symlinkSync(realYaml, yamlPath, 'file')
    const report = applyIsolateConfig(home)
    expect(report.actions[0]).toMatchObject({ name: 'linked', action: 'refused' })
    // The linked TARGET was never written either.
    expect(readFileSync(realYaml, 'utf8')).toBe('packages:\n  - .\n')
  })

  it('a failed write leaves the original file byte-identical and records refusal', () => {
    const profile = makeProfile('blocked', { yaml: 'packageImportMethod: clone\n' })
    const yamlPath = join(profile, 'pnpm-workspace.yaml')
    // Occupy the sibling temp path with a DIRECTORY so writeFileSync fails —
    // the rename never happens and the original survives.
    const tempBlocker = `${yamlPath}.mrw-${process.pid}.tmp`
    mkdirSync(tempBlocker)
    try {
      const report = applyIsolateConfig(home)
      expect(report.actions[0]).toMatchObject({ action: 'refused', detail: expect.stringContaining('write failed') })
      expect(readFileSync(yamlPath, 'utf8')).toBe('packageImportMethod: clone\n')
    } finally {
      rmSync(tempBlocker, { recursive: true, force: true })
    }
  })
})

describe('remediationSteps', () => {
  it('prints quit + remove + reinstall per migrated profile with node_modules, and the boundaries', () => {
    makeProfile('ready', { withModules: true })
    makeProfile('empty') // no node_modules — config alone suffices
    const report = applyIsolateConfig(home)
    const steps = remediationSteps(report).join('\n')
    expect(steps).toContain(`profile "ready"`)
    expect(steps).toContain('Remove-Item -Recurse -Force')
    expect(steps).toContain(`pnpm --dir '${join(home, 'profiles', 'ready')}' install`)
    expect(steps).not.toContain('profile "empty" — quit')
    expect(steps).toContain('does not isolate existing dependencies')
    expect(steps).toContain('Administrators ownership')
    expect(steps).toContain('no automatic reset')
    expect(steps).toContain('Profiles created later')
  })

  it('a refused profile gets a manual-resolution line, not automated steps', () => {
    makeProfile('stuck', { yaml: 'packageImportMethod: &m copy\n', withModules: true })
    const report = applyIsolateConfig(home)
    const steps = remediationSteps(report).join('\n')
    expect(steps).toContain(`profile "stuck" was refused`)
    expect(steps).not.toMatch(/profile "stuck".*pnpm --dir/)
  })

  it("single quotes escape for PowerShell", () => {
    const profile = makeProfile("it's", { withModules: true })
    const report = applyIsolateConfig(home)
    const steps = remediationSteps(report).join('\n')
    expect(steps).toContain(`pnpm --dir '${profile.replaceAll("'", "''")}' install`)
  })
})
