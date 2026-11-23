import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SshDependencyView } from '../remote/ssh-diagnostics.ts'
import {
  classifySshCapability, insidePackageRoot, pluginPackageRoot, SSH_PEER_PACKAGES, SUPPORTED_SSH_RELEASES,
  type CompatReport, type SshAbsentReason, type SshCapability, type SshPackageLocation,
} from './dsh-version.ts'

interface ProfileContext {
  readonly dir: string
  readonly name: string
  readonly installAnchor: string
  readonly home: string
}

interface Resolution {
  readonly entries: readonly { name: string; packageDir: string; scope: string }[]
}

type PackageInspection = SshDependencyView['packages'][number] & {
  readonly location?: SshPackageLocation
  readonly identity?: string
}

const selfRequire = createRequire(import.meta.url)
const pluginRoot = pluginPackageRoot(selfRequire)
const startup = new WeakMap<ProfileContext, PackageInspection[]>()

function real(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

function resolvePackage(require: NodeRequire, name: string): string | undefined {
  try { return real(require.resolve(`${name}/package.json`)) } catch { return undefined }
}

function profileFacts(ctx: Context): { profile?: ProfileContext; resolution?: Resolution } {
  const candidate = ctx.get('profileContext') as Partial<ProfileContext> | undefined
  const profile = candidate === undefined || typeof candidate.dir !== 'string' || typeof candidate.name !== 'string'
    || typeof candidate.home !== 'string' || typeof candidate.installAnchor !== 'string' ? undefined : candidate as ProfileContext
  const table = (ctx.get('pluginPackages') as { resolution?: Resolution } | undefined)?.resolution
  const resolution = Array.isArray(table?.entries) ? table : undefined
  return { ...(profile === undefined ? {} : { profile }), ...(resolution === undefined ? {} : { resolution }) }
}

function inspectPackage(name: string, expected: string | undefined, profile?: ProfileContext, resolution?: Resolution): PackageInspection {
  const hostAnchor = profile?.installAnchor ?? resolvePackage(selfRequire, '@deepseek-ai/dsh')
  const hostRequire = hostAnchor === undefined || !isAbsolute(hostAnchor) || (profile === undefined && insidePackageRoot(hostAnchor, pluginRoot))
    ? undefined : createRequire(hostAnchor)
  const installation = resolution?.entries.find(entry => entry.scope === 'installation' && entry.name === name)
  const hostManifest = installation === undefined
    ? resolution !== undefined || hostRequire === undefined ? undefined : resolvePackage(hostRequire, name)
    : real(join(installation.packageDir, 'package.json'))
  const profileModules = profile === undefined ? undefined : real(join(profile.dir, 'node_modules'))
  const profileManifest = profileModules === undefined ? undefined : real(join(profileModules, name, 'package.json'))
  if (hostManifest === undefined && profileManifest !== undefined && resolution === undefined) {
    return { name, state: 'unresolvable' }
  }
  const manifest = hostManifest ?? profileManifest
  if (manifest === undefined) {
    return { name, state: insidePackageRoot(resolvePackage(selfRequire, name) ?? '', pluginRoot) ? 'private' : 'missing' }
  }
  if (hostManifest === undefined
    && (!insidePackageRoot(manifest, profileModules) || !insidePackageRoot(profileModules!, real(profile!.dir)))) {
    return { name, state: 'private' }
  }
  if (hostManifest !== undefined && installation === undefined && insidePackageRoot(manifest, pluginRoot)) {
    return { name, state: 'private' }
  }

  try {
    if (hostManifest === undefined) {
      const profileManifest = JSON.parse(readFileSync(join(profile!.dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
      if (typeof profileManifest.dependencies?.[name] !== 'string') return { name, state: 'unresolvable' }
    }
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown; peerDependencies?: Record<string, unknown> }
    if (data.name !== name || typeof data.version !== 'string' || !/^[\w.+-]{1,64}$/.test(data.version)) return { name, state: 'unresolvable' }
    if (data.version !== expected) return { name, state: 'version-mismatch', version: data.version }

    const require = createRequire(hostManifest === undefined ? join(profile!.dir, 'package.json') : manifest)
    const entry = real(require.resolve(name))
    const root = dirname(manifest)
    const broken = { name, state: 'unresolvable', version: data.version } as const
    if (entry === undefined || !insidePackageRoot(entry, root)) return broken
    if (hostManifest === undefined && resolution !== undefined) {
      const fromPackage = createRequire(manifest)
      for (const peer of Object.keys(data.peerDependencies ?? {})) {
        if ((SSH_PEER_PACKAGES as readonly string[]).includes(peer)) {
          const installed = resolution.entries.find(entry => entry.scope === 'installation' && entry.name === peer)
          const selected = installed === undefined ? resolvePackage(require, peer) : real(join(installed.packageDir, 'package.json'))
          if (selected === undefined || selected !== resolvePackage(fromPackage, peer)) return broken
        } else if (peer === '@deepseek-ai/cordis' || peer.startsWith('@deepseek-ai/dsh-')) {
          const installed = resolution.entries.find(entry => entry.scope === 'installation' && entry.name === peer)
          const selected = installed === undefined ? undefined : real(join(installed.packageDir, 'package.json'))
          if (selected === undefined || selected !== resolvePackage(fromPackage, peer)) return broken
        }
      }
    }
    const identity = [manifest, entry].map(path => {
      const { dev, ino, mtimeMs, size } = statSync(path)
      return `${dev}:${ino}:${mtimeMs}:${size}`
    }).join('/')
    return { name, state: 'installed', version: data.version, location: { root, entry }, identity }
  } catch {
    return { name, state: 'unresolvable' }
  }
}

/** Capture package identities when the Host rows are composed, even with SSH disabled. */
export function captureSshProfile(ctx: Context): void {
  const { profile, resolution } = profileFacts(ctx)
  if (profile === undefined || startup.has(profile)) return
  const report = ctx.get('multiRootCompat')?.report
  if (report?.verdict !== 'supported' || !SUPPORTED_SSH_RELEASES.some(release => release === report.release)) return
  startup.set(profile, SSH_PEER_PACKAGES.map(name => inspectPackage(name, report.release, profile, resolution)))
}

const codes: Record<SshAbsentReason, SshDependencyView['code']> = {
  'platform-deferred': 'ssh-host-platform',
  'local-compat-not-supported': 'ssh-host-unsupported',
  'host-below-floor': 'ssh-host-unsupported',
  'missing-optional-package': 'ssh-deps-missing',
  'partial-optional-packages': 'ssh-deps-partial',
  'version-mismatch': 'ssh-deps-version',
  'private-copy': 'ssh-deps-private',
  'identity-mismatch': 'ssh-deps-resolution',
}

function quoteProfileValue(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function commandFor(profile: ProfileContext | undefined, release: string): string | undefined {
  if (profile === undefined || !isAbsolute(profile.home) || profile.name.length === 0
    || ['.', '..', 'node_modules'].includes(profile.name) || /[/\\\0\r\n]/.test(profile.name)
    || /[\0\r\n]/.test(profile.home)) return undefined
  const expected = real(join(profile.home, 'profiles', profile.name))
  if (expected === undefined || expected !== real(profile.dir)) return undefined
  const specs = SSH_PEER_PACKAGES.map(name => `${name}@${release}`)
  const selection = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(profile.name)
    ? `--profile ${profile.name}` : `--profile=${quoteProfileValue(profile.name)}`
  return `DSH_HOME=${quoteProfileValue(profile.home)} dsh plugin ${selection} add --save-exact ${specs.join(' ')}`
}

export function inspectSshProfile(ctx: Context): { view: SshDependencyView; gate?: SshCapability } {
  const { profile, resolution } = profileFacts(ctx)
  const local: CompatReport = ctx.get('multiRootCompat')?.report ?? {
    verdict: 'incomplete', release: undefined, packages: [], message: '',
  }
  const packages = SSH_PEER_PACKAGES.map(name => inspectPackage(name, local.release, profile, resolution))
  const gate = classifySshCapability({
    platform: process.platform, local,
    readVersion: name => packages.find(entry => entry.name === name)?.version,
    privateCopy: name => packages.some(entry => entry.name === name && entry.state === 'private'),
  })
  let code: SshDependencyView['code'] = gate.status === 'eligible' ? 'ready' : codes[gate.reason]
  if (code !== 'ssh-host-platform' && code !== 'ssh-host-unsupported'
    && packages.some(entry => entry.state === 'unresolvable')) code = 'ssh-deps-resolution'
  if (code === 'ready' && profile !== undefined && JSON.stringify(packages) !== JSON.stringify(startup.get(profile))) {
    code = 'ssh-deps-restart'
  }
  const release = local.release
  const command = release === undefined || code === 'ready' || code === 'ssh-deps-restart' || code.startsWith('ssh-host-')
    ? undefined : commandFor(profile, release)
  const view = {
    code, packages: packages.map(({ name, state, version }) => ({ name, state, ...(version === undefined ? {} : { version }) })),
    ...(release === undefined ? {} : { release }), ...(profile === undefined ? {} : { profile: profile.name }),
    ...(command === undefined ? {} : { command }),
  }
  if (code !== 'ready' || gate.status !== 'eligible') return { view }
  return { view, gate: { ...gate, locations: Object.fromEntries(packages.map(entry => [entry.name, entry.location!])) } }
}
