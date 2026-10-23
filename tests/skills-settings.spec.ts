import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import NativeSkills from '@deepseek-ai/dsh-skill'
import * as Skills from '../src/skills.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
let fixture: FixtureWorkspace
beforeEach(() => { fixture = createFixtureWorkspace('skills-settings') })
afterEach(() => fixture.dispose())

describe('live Host Skills settings', () => {
  it('supports legacy installSection arrival/removal and invalidates native cached catalogs', async () => {
    const stack = await skillsStack(fixture.base)
    try {
      const primary = project(fixture.base, 'a'), root = project(fixture.base, 'root')
      writeSkill(root, 'review', 'BODY'); await stack.registry.add(primary, { path: root })
      const agent = stack.agent(primary); expect((await stack.snapshot(agent)).skills).toHaveLength(1)
      let hooks!: { setSource(source: () => { enabled: boolean }): void; onChange(): void }
      let enabled = true
      const settings = await stack.ctx.plugin({ apply(ctx) { ctx.provide('settings', { installSection: (_owner: unknown, ns: string, _schema: unknown, _value: unknown, callbacks: typeof hooks) => {
        expect(ns).toBe('multi-root-skills'); hooks = callbacks; hooks.setSource(() => ({ enabled }))
      } } as never) } })
      const generation = stack.ctx.multiRootSkills.generation
      enabled = false; hooks.onChange()
      expect(stack.ctx.multiRootSkills.enabled).toBe(false)
      expect(stack.ctx.multiRootSkills.generation).toBeGreaterThan(generation)
      expect((await stack.snapshot(agent)).skills).toEqual([])
      expect(stack.registry.list(primary)[0]?.skillsEnabled).toBe(true)
      enabled = true; hooks.onChange(); expect((await stack.snapshot(agent)).skills).toHaveLength(1)
      await settings.dispose()
      expect(stack.ctx.multiRootSkills.enabled).toBe(true)
    } finally { await stack.dispose() }
  })

  it('maps real Loader/Settings edits to the Skills row, without remounting it or editing Registry', async () => {
    const stack = await skillsStack(fixture.base)
    let instance: Awaited<ReturnType<typeof boot>> | undefined
    try {
      const directory = join(fixture.base, 'profile'), bundle = join(directory, 'node_modules/skills-fixture')
      initProfile(directory, ['skills-fixture']); mkdirSync(bundle, { recursive: true })
      writeFileSync(join(fixture.base, 'package.json'), '{"name":"skills-test-home"}')
      writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'skills-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
        { id: 'multi-root-registry', name: 'cordis:dependencies' }, { id: 'multi-root-skills', name: 'cordis:skills' },
      ] }]))
      writeFileSync(join(directory, 'cordis.yml'), '[]\n')
      const profile = { name: 'skills', dir: directory, home: fixture.base, startedBundles: ['skills-fixture'], patchPath: join(directory, 'cordis.patch.yml'), installAnchor: join(fixture.base, 'package.json'), cwd: fixture.base, overlays: [], telemetryDisabledEnv: undefined }
      instance = await boot('skills', join(directory, 'cordis.yml'), readProfilePatches('skills', profile as never), ctx => {
        ctx.provide('profileContext', profile as never)
        ctx.provide('appReady', { onReady: (callback: () => void) => { callback(); return () => {} } } as never)
        Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, skills: Skills,
          dependencies: { async apply(scope: typeof ctx) {
            for (const name of ['multiRootCompat', 'multiRootProviders', 'multiRootScope', 'multiRootRegistry', 'fs'] as const) scope.provide(name, stack.ctx.get(name) as never)
            await scope.plugin(NativeSkills)
          } },
        })
      })
      const service = instance.multiRootSkills
      const descriptors = instance.settings.describe()
      const descriptor = descriptors.find(row => row.ns === 'multi-root-skills')
      expect(descriptor).toBeDefined()
      expect(descriptors.some(row => row.ns === 'multi-root-registry' || row.ns === 'skills-fixture')).toBe(false)
      const generation = service.generation
      const marker = Symbol('owner-marker'), token = {}
      Object.defineProperty(service, marker, { value: token })
      await instance.settings.mutate('multi-root-skills' as never, [{ op: 'set', path: ['enabled'], value: false }], descriptor!.revision)
      expect((instance.multiRootSkills as unknown as Record<symbol, unknown>)[marker]).toBe(token)
      expect(service.enabled).toBe(false); expect(service.generation).toBeGreaterThan(generation)
      await instance.settings.mutate('multi-root-skills' as never, [{ op: 'set', path: ['enabled'], value: true }])
      expect(service.enabled).toBe(true)
      const patch = readFileSync(profile.patchPath, 'utf8')
      expect(patch).toContain('multi-root-skills'); expect(patch).not.toContain('multi-root-registry')
    } finally { await instance?.fiber.dispose(); await stack.dispose() }
  })
})
