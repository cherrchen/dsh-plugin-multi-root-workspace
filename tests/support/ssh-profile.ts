import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SSH_PEER_PACKAGES } from '../../src/compat/dsh-version.ts'
import { captureSshProfile } from '../../src/compat/ssh-profile.ts'

export function provideSshProfile(ctx: Context, home: string, name = 'web'): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  ctx.provide('profileContext', { dir, home, name, installAnchor: join(home, 'host', 'package.json') } as never)
  ctx.provide('pluginPackages', { resolution: { entries: [] } } as never)
  return dir
}

export function installFixtureSsh(dir: string, release: string, names: readonly string[] = SSH_PEER_PACKAGES): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [name, release])) }))
  for (const name of names) {
    const root = join(dir, 'node_modules', name)
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: release, main: './index.js' }))
    writeFileSync(join(root, 'index.js'), 'module.exports = {}')
  }
}

export function provideReadySshProfile(ctx: Context, home: string, release: string): string {
  const dir = provideSshProfile(ctx, home)
  installFixtureSsh(dir, release)
  captureSshProfile(ctx)
  return dir
}
