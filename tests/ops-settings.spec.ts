import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import Settings from '@deepseek-ai/dsh-settings'
import { MultiRootOpsCompatibility, Config } from '../src/ops-compatibility.ts'
import { OPS_SETTINGS_ID, opsCompatibilityToken, opsCompatibilityRelease } from '../src/compat/ops-settings.ts'
import { installOpsSetting } from './support/ops-settings.ts'
import { readInstalledVersion } from '../src/compat/dsh-version.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'

const settingsRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot/package.json'))
let configEditorPath: string | undefined
try { configEditorPath = settingsRequire.resolve('@deepseek-ai/dsh-config-editor') } catch { /* Old Settings use a namespace provider. */ }

async function mount(enabled: unknown = {}, release: string = '0.2.2-rc.1', withSettings = true): Promise<{ ctx: Context; service: MultiRootOpsCompatibility | undefined; fiber: { dispose(): Promise<unknown> } }> {
  const ctx = new Context()
  ctx.provide('multiRootCompat', { release } as never); ctx.provide('multiRootProviders', {}); ctx.provide('multiRootScope', {})
  if (withSettings) ctx.provide('settings', { configure: () => () => {} } as never)
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

  it('tracks modern Settings arrival/removal and regenerates the token per generation', async () => {
    const { ctx, fiber } = await mount({ enabled: true }, '0.2.2-rc.1', false)
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    let setEnabled!: (value: boolean) => void
    const settings = await ctx.plugin({ apply(scope: Context) { setEnabled = installOpsSetting(scope) } })
    const first = opsCompatibilityToken(ctx); expect(first).toBeInstanceOf(Object)
    setEnabled(false); expect(opsCompatibilityToken(ctx)).toBeUndefined()
    setEnabled(true)
    const second = opsCompatibilityToken(ctx)
    expect(second).toBeInstanceOf(Object); expect(second).not.toBe(first)
    await settings.dispose()
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    await fiber.dispose()
  })

  it.each(['0.1.5-rc.2', '0.1.6-alpha.2', '0.1.7-rc.2', '0.3.0', ''])('keeps explicit opt-in off on ineligible or unknown DSH %s', async release => {
    // Even a modern-looking Settings service cannot override the release policy.
    const { ctx, fiber } = await mount({ enabled: true }, release, true)
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    expect(ctx.multiRootOpsCompatibility.enabled).toBe(false)
    await fiber.dispose()
  })

  it.each(['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1'])('allows explicit opt-in on DSH %s', async release => {
    const { ctx, fiber } = await mount({ enabled: true }, release)
    expect(opsCompatibilityToken(ctx)).toBeInstanceOf(Object)
    await fiber.dispose()
  })

  it('does not attach a legacy Settings section even on an eligible release', async () => {
    const { ctx, fiber } = await mount({ enabled: true }, '0.2.0-rc.2', false)
    let installed = false
    const settings = await ctx.plugin({ apply(scope: Context) {
      scope.provide('settings', { installSection: () => { installed = true } } as never)
    } })
    expect(installed).toBe(false)
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
    await settings.dispose(); await fiber.dispose()
  })

  it('treats a missing service as off', async () => {
    const ctx = new Context()
    expect(opsCompatibilityToken(ctx)).toBeUndefined()
  })
})

describe('OPS compatibility settings — real Loader/Settings', () => {
  it.skipIf(configEditorPath === undefined)('exposes live settings only on eligible hosts and persists their writes across restart', async () => {
    const fixture = createFixtureWorkspace('ops-settings')
    try {
      const deps = new Context()
      deps.provide('multiRootCompat', { release: readInstalledVersion('@deepseek-ai/dsh') } as never); deps.provide('multiRootProviders', {}); deps.provide('multiRootScope', {})
      const directory = join(fixture.base, 'profile'), bundle = join(directory, 'node_modules/ops-fixture')
      initProfile(directory, ['ops-fixture']); mkdirSync(bundle, { recursive: true })
      writeFileSync(join(fixture.base, 'package.json'), '{"name":"ops-settings-home"}')
      writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'ops-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
        { id: 'multi-root-deps', name: 'cordis:dependencies' }, { id: OPS_SETTINGS_ID, name: 'cordis:ops', enabled: !opsCompatibilityRelease(readInstalledVersion('@deepseek-ai/dsh')) },
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
        if (!opsCompatibilityRelease(readInstalledVersion('@deepseek-ai/dsh'))) {
          expect(descriptor).toBeUndefined()
          expect(instance.multiRootOpsCompatibility.enabled).toBe(false)
          expect(instance.multiRootOpsCompatibility.token).toBeUndefined()
          expect(instance.settings.describe().some((row: { ns: string }) => row.ns === OPS_SETTINGS_ID)).toBe(false)
          return
        }
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
