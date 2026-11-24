import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SSH_PEER_PACKAGES } from '../../src/compat/dsh-version.ts'
import { captureSshProfile } from '../../src/compat/ssh-profile.ts'

export function provideSshProfile(ctx: Context, home: string, name = 'web', release = '0.2.2-rc.5'): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  const anchor = join(home, 'host', 'package.json')
  mkdirSync(join(home, 'host', 'lib'), { recursive: true })
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: release, bin: { dsh: 'lib/bin.js' } }))
  writeFileSync(join(home, 'host', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  ctx.provide('profileContext', { dir, home, name, installAnchor: anchor } as never)
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
