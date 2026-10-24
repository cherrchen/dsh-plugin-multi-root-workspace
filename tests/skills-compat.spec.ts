/** Runs unchanged in the existing exact-release CI matrix. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isSkillName, isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { filesystemSkillsApi, skillOrigin, configValue, volatileField } from '../src/compat/skills.ts'
import MultiRootSkills, { Config } from '../src/skills.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const candidate: SkillCandidate = { name: 'mr-contract', description: 'contract', source: 'custom', provider: 'multi-root-contract', rank: Number.MAX_SAFE_INTEGER, invocation: { modelInvocable: true, userInvocable: false }, locator: null }

describe('native Skills contracts', () => {
  it('borrows scope on list/get, separates same-cwd scopes, and invalidates completed catalogs', async () => {
    const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    let control!: SkillProviderControl
    let count = 0
    const scopes: unknown[] = []
    ctx.skills.registerProvider(value => { control = value; return {
      name: candidate.provider,
      list: async options => { count++; scopes.push((options as { scope?: unknown }).scope); return [candidate] },
      get: async (_entry, options) => { scopes.push((options as { scope?: unknown }).scope); return { ...candidate, content: 'body' } },
    } })
    const a = {}, b = {}
    const first = { cwd: process.cwd(), scope: a }
    await ctx.skills.snapshot(first)
    await ctx.skills.snapshot(first)
    expect(count).toBe(1)
    await ctx.skills.snapshot({ ...first, scope: b })
    expect(count).toBe(2)
    expect(scopes).toEqual([a, b])
    await ctx.skills.get(candidate.name, first)
    expect(scopes.at(-1)).toBe(a)
    control.invalidate()
    await ctx.skills.snapshot(first)
    expect(count).toBe(3)
    expect(isModelInvocable(candidate)).toBe(true)
    expect(isUserInvocable(candidate)).toBe(false)
    expect(isSkillName('repo:skill')).toBe(false)
    expect(isSkillName(candidate.name)).toBe(true)
  })

  it('uses the public isolated filesystem parser and closes it without watchers', async () => {
    const api = await filesystemSkillsApi()
    expect(api?.FileSystemSkillProvider).toBeTypeOf('function')
    const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
    const reader = new api!.FileSystemSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, { includeDefaultRoots: false, customSkillDirs: [], watch: false })
    expect(await reader.list({ cwd: process.cwd() })).toEqual([])
    await reader.dispose()
  })

  it('does not derive Session authority from cwd or a preset-shaped scope', () => {
    const agent = { id: 'session', session: { header: { cwd: process.cwd() } } }
    const ctx = new Context(); ctx.provide('agents', { get: () => agent } as never)
    expect(skillOrigin(ctx, { cwd: '/shared', scope: agent } as never)).toBe(process.cwd())
    expect(skillOrigin(ctx, { cwd: process.cwd() })).toBeUndefined()
    expect(skillOrigin(ctx, { scope: { ...agent } } as never)).toBeUndefined()
    expect(skillOrigin(ctx, { scope: {} } as never)).toBeUndefined()
  })

  it('waits for real gates and remains harmless in a minimal Registry composition', async () => {
    const absent = new Context(); cleanups.push(() => absent.fiber.dispose())
    await absent.plugin(MultiRootSkills)
    expect(absent.get('multiRootSkills')).toBeUndefined()
    const directory = await mkdtemp(join(tmpdir(), 'skills-contract-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const stack = await mountRegistryStack(directory); cleanups.push(stack.dispose)
    await stack.ctx.plugin(MultiRootSkills)
    expect(stack.ctx.multiRootSkills.enabled).toBe(true)
    expect(stack.ctx.get('skills')).toBeUndefined()
    expect(stack.registry.list(process.cwd())).toEqual([])
  })

  it('adapts both Config field shapes without interpreting a reference as true', () => {
    expect(configValue(false)).toBe(false)
    const ref = { [Symbol.for('cosmokit.volatile.write')]: true, get: () => false }
    expect(configValue(ref)).toBe(false)
    const legacy = {}; expect(volatileField(legacy)).toBe(legacy)
    expect(volatileField({ volatile: () => 'modern' } as unknown)).toBe('modern')
    expect(Config).toBeDefined()
  })
})
