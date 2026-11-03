import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import Settings from '@deepseek-ai/dsh-settings'
import { MultiRootOpsCompatibility, Config } from '../src/ops-compatibility.ts'
import { OPS_SETTINGS_ID, opsCompatibilityToken } from '../src/compat/ops-settings.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'

const settingsRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot/package.json'))
let configEditorPath: string | undefined
try { configEditorPath = settingsRequire.resolve('@deepseek-ai/dsh-config-editor') } catch { /* Old Settings use a namespace provider. */ }

async function mount(enabled: unknown = {}): Promise<{ ctx: Context; service: MultiRootOpsCompatibility | undefined; fiber: { dispose(): Promise<unknown> } }> {
  const ctx = new Context()
  ctx.provide('multiRootCompat', {}); ctx.provide('multiRootProviders', {}); ctx.provide('multiRootScope', {})
  const fiber = await ctx.plugin(MultiRootOpsCompatibility, enabled as never)
  return { ctx, service: ctx.get('multiRootOpsCompatibility'), fiber: fiber as never }
}

describe('OPS compatibility settings row', () => {
  it('defaults off and only enables on a literal true', async () => {
    const { ctx, fiber } = await mount()
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    await fiber.dispose()
    const off = await mount({ enabled: false })
    expect(opsCompatibilityToken(off.ctx)).toBeUndefined()
    await off.fiber.dispose()
    for (const value of [{ enabled: 'yes' }, { enabled: 1 }, { enabled: {} }, { enabled: ['true'] }]) {
      await expect(mount(value)).rejects.toThrow()
    }
    const on = await mount({ enabled: true })
    expect(opsCompatibilityToken(on.ctx)).toBeInstanceOf(Object)
    await on.fiber.dispose()
  })

  it('describes the row as experimental OPS compatibility with the limitation warning', () => {
    const meta = (Config as unknown as { dict: { enabled: { meta?: { description?: string; badges?: { text: string }[]; default?: boolean } } } }).dict.enabled.meta
    expect(meta?.default).toBe(false)
    expect(meta?.badges?.some(badge => badge.text === 'experimental')).toBe(true)
    expect(meta?.description).toContain('OPS 兼容模式')
    expect(meta?.description).toContain('实验性')
    expect(meta?.description).toContain('限制')
    expect(meta?.description).toContain('显式只读附加根可能被 OPS 写入')
  })

  it('supports legacy installSection arrival/removal and regenerates the token per generation', async () => {
    const { ctx, service } = await mount()
    let hooks!: { setSource(source: () => { enabled: boolean }): void; onChange(): void }
    let enabled = false
    const fiber = await ctx.plugin({ apply(scope: Context) { scope.provide('settings', { installSection: (_owner: unknown, ns: string, _schema: unknown, _value: unknown, callbacks: typeof hooks) => {
      expect(ns).toBe(OPS_SETTINGS_ID); hooks = callbacks; hooks.setSource(() => ({ enabled }))
    } } as never) } })
    await new Promise(resolve => setTimeout(resolve, 0))
    enabled = true; hooks.onChange()
    const first = opsCompatibilityToken(ctx); expect(first).toBeInstanceOf(Object)
    enabled = false; hooks.onChange(); expect(opsCompatibilityToken(ctx)).toBeUndefined()
    enabled = true; hooks.onChange()
    const second = opsCompatibilityToken(ctx)
    expect(second).toBeInstanceOf(Object); expect(second).not.toBe(first)
    expect((second as { id?: string }).id).not.toBe((first as { id?: string }).id)
    await fiber.dispose()
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    void service
  })

  it('treats a missing service as off', async () => {
    const ctx = new Context()
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
  })

  it.skipIf(typeof (Settings.prototype as { installSection?: unknown }).installSection !== 'function')('writes through a real legacy Settings provider without remounting', async () => {
    const { ctx } = await mount()
    class LegacySettings extends (Settings as unknown as { new (...args: unknown[]): unknown }) { readonly writable = true; async load() { return {} } async persist() {} }
    await ctx.plugin(LegacySettings as never)
    const settings = ctx.get('settings') as { describe(): { ns: string }[]; mutate(ns: string, ops: unknown[]): Promise<void> }
    expect(settings.describe().some(row => row.ns === OPS_SETTINGS_ID)).toBe(true)
    await settings.mutate(OPS_SETTINGS_ID as never, [{ op: 'set', path: ['enabled'], value: true }])
    expect(opsCompatibilityToken(ctx)).toBeInstanceOf(Object)
    await settings.mutate(OPS_SETTINGS_ID as never, [{ op: 'set', path: ['enabled'], value: false }])
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
  })
})

describe('OPS compatibility settings — real Loader/Settings', () => {
  it.skipIf(configEditorPath === undefined)('exposes the descriptor, persists writes through the real Settings service, and survives restart', async () => {
    const fixture = createFixtureWorkspace('ops-settings')
    try {
      const deps = new Context()
      deps.provide('multiRootCompat', {}); deps.provide('multiRootProviders', {}); deps.provide('multiRootScope', {})
      const directory = join(fixture.base, 'profile'), bundle = join(directory, 'node_modules/ops-fixture')
      initProfile(directory, ['ops-fixture']); mkdirSync(bundle, { recursive: true })
      writeFileSync(join(fixture.base, 'package.json'), '{"name":"ops-settings-home"}')
      writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'ops-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
        { id: 'multi-root-deps', name: 'cordis:dependencies' }, { id: OPS_SETTINGS_ID, name: 'cordis:ops' },
      ] }]))
      writeFileSync(join(directory, 'cordis.yml'), '[]\n')
      const ConfigEditor = (await import(pathToFileURL(configEditorPath!).href)).default
      const profile = { name: 'ops', dir: directory, home: fixture.base, startedBundles: ['ops-fixture'], patchPath: join(directory, 'cordis.patch.yml'), installAnchor: join(fixture.base, 'package.json'), cwd: fixture.base, overlays: [], telemetryDisabledEnv: undefined }
      const bootProfile = async () => await boot('ops', join(directory, 'cordis.yml'), readProfilePatches('ops', profile as never), ctx => {
        ctx.provide('profileContext', profile as never)
        ctx.provide('appReady', { onReady: (callback: () => void) => { callback(); return () => {} } } as never)
        Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, ops: MultiRootOpsCompatibility,
          dependencies: { async apply(scope: typeof ctx) {
            for (const name of ['multiRootCompat', 'multiRootProviders', 'multiRootScope'] as const) scope.provide(name, deps.get(name) as never)
          } },
        })
      })
      let instance = await bootProfile()
      try {
        const descriptor = instance.settings.describe().find((row: { ns: string }) => row.ns === OPS_SETTINGS_ID)
        expect(descriptor).toBeDefined()
        expect(JSON.stringify(descriptor)).toContain('OPS 兼容模式')
        expect(JSON.stringify(descriptor)).toContain('experimental')
        expect(JSON.stringify(descriptor)).toContain('false')
        const service = instance.multiRootOpsCompatibility as MultiRootOpsCompatibility
        expect(service.enabled).toBe(false); expect(service.token).toBeUndefined()
        const mutate = (value: boolean) => instance.settings.mutate(OPS_SETTINGS_ID as never, [{ op: 'set', path: ['enabled'], value }],
          instance.settings.describe().find((row: { ns: string }) => row.ns === OPS_SETTINGS_ID)!.revision)
        await mutate(true)
        const first = service.token; expect(first).toBeInstanceOf(Object)
        await mutate(false)
        expect(service.token).toBeUndefined()
        await mutate(true)
        const second = service.token; expect(second).toBeInstanceOf(Object); expect(second).not.toBe(first)
        expect(readFileSync(profile.patchPath, 'utf8')).toContain(OPS_SETTINGS_ID)
      } finally { await instance.fiber.dispose() }
      instance = await bootProfile()
      try { expect((instance.multiRootOpsCompatibility as MultiRootOpsCompatibility).enabled).toBe(true) }
      finally { await instance.fiber.dispose() }
    } finally { fixture.dispose() }
  })
})
