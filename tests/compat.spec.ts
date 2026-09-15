/**
 * The DSH compatibility contract.
 *
 * Three properties are pinned here, because each of them is a way the contract
 * could quietly stop being a contract:
 *
 * 1. the allowlist is a list of EXACT versions, and the release this suite runs
 *    against is on it — a suite passing against an unverified release is the
 *    exact failure this whole mechanism exists to prevent;
 * 2. `package.json`'s `peerDependencies` say the same thing as the allowlist —
 *    npm metadata that over-promises is what started this work;
 * 3. incomplete, mixed and unsupported installations are each refused, loudly,
 *    with the offending versions named.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { assertSupportedInstallation, DshCompatUnsupportedError } from '../src/compat.ts'
import {
  classifyInstallation,
  compatEnforcement,
  CORE_PACKAGES,
  OPTIONAL_CORE_PACKAGES,
  readInstalledVersion,
  REQUIRED_CORE_PACKAGES,
  SUPPORTED_DSH_RELEASES,
  type VersionReader,
} from '../src/compat/dsh-version.ts'
import { MultiRootFileSystem } from '../src/fs.ts'
import * as Instructions from '../src/instructions.ts'
import { MultiRootRegistry } from '../src/registry.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace, REPO_ROOT } from './support/temp-workspace.ts'

/** A reader that reports one version for everything, then applies overrides. */
function reader(base: string | undefined, overrides: Record<string, string | undefined> = {}): VersionReader {
  return name => (name in overrides ? overrides[name] : base)
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the supported release list', () => {
  it('is a non-empty list of exact versions, not ranges', () => {
    expect(SUPPORTED_DSH_RELEASES.length).toBeGreaterThan(0)
    for (const release of SUPPORTED_DSH_RELEASES) {
      expect(release, `${release} must be an exact version`).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    }
  })

  it('has no duplicate entries', () => {
    expect([...new Set(SUPPORTED_DSH_RELEASES)]).toEqual([...SUPPORTED_DSH_RELEASES])
  })

  it('inspects every package this plugin couples to, required before optional', () => {
    expect(CORE_PACKAGES).toEqual([...REQUIRED_CORE_PACKAGES, ...OPTIONAL_CORE_PACKAGES])
    expect(new Set(CORE_PACKAGES).size).toBe(CORE_PACKAGES.length)
  })
})

/**
 * Whether this run is an upgrade probe.
 *
 * The two lanes ask different questions of the installed release, so exactly one
 * of the two cases below applies:
 *
 * - the normal lane asserts the installation IS supported, which is what makes
 *   the rest of the suite valid evidence for the allowlist;
 * - the upgrade lane runs against a candidate that is deliberately not on the
 *   allowlist yet, so it asserts only that warn mode let it through — and that
 *   even warn mode still refuses a tree that mixes releases.
 */
const upgradeLane = compatEnforcement() === 'warn'

describe('the release this suite runs against', () => {
  it.skipIf(upgradeLane)('is on the allowlist, with every core package agreeing on it', () => {
    const report = classifyInstallation()
    expect(report.message).toContain('supported')
    expect(report.verdict).toBe('supported')
    expect(SUPPORTED_DSH_RELEASES).toContain(report.release)
  })

  it.runIf(upgradeLane)('is a candidate warn mode lets through, on one coherent release', () => {
    const report = classifyInstallation()
    // Even the upgrade lane has a floor: an incomplete or mixed tree tells us
    // nothing about the candidate, so it is refused in either mode.
    expect(report.verdict, report.message).not.toBe('incomplete')
    expect(report.verdict, report.message).not.toBe('mixed')
    expect(report.release).toBeTypeOf('string')
    expect(() => assertSupportedInstallation(report, 'warn')).not.toThrow()
  })

  it('is the version the manifest pins for development', () => {
    const report = classifyInstallation()
    expect(manifest.devDependencies['@deepseek-ai/dsh-sandbox-local']).toBe(report.release)
  })

  it('resolves through the same peer copy the providers will subclass', () => {
    for (const name of REQUIRED_CORE_PACKAGES) {
      expect(readInstalledVersion(name), `${name} must resolve`).toBeTypeOf('string')
    }
  })
})

describe('peerDependencies and the allowlist agree', () => {
  const expected = SUPPORTED_DSH_RELEASES.join(' || ')

  it('declares exactly the allowlisted releases for every dsh peer', () => {
    const dshPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      expect(range, `${name} must promise exactly the allowlist`).toBe(expected)
    }
  })

  it('declares every required core package as a peer', () => {
    for (const name of REQUIRED_CORE_PACKAGES) {
      expect(Object.keys(manifest.peerDependencies), `${name} must be a peer`).toContain(name)
    }
  })
})

describe('an installation that cannot be judged', () => {
  it('is incomplete when a required package is absent, and names it', () => {
    const report = classifyInstallation(reader('0.1.5-rc.2', { '@deepseek-ai/dsh-sandbox-local': undefined }))
    expect(report.verdict).toBe('incomplete')
    expect(report.release).toBeUndefined()
    expect(report.message).toContain('@deepseek-ai/dsh-sandbox-local')
  })

  it('stays supported when only an optional package is absent', () => {
    const release = SUPPORTED_DSH_RELEASES[0]
    const report = classifyInstallation(reader(release, { '@deepseek-ai/dsh-client-connection': undefined }))
    expect(report.verdict).toBe('supported')
    expect(report.release).toBe(release)
  })
})

describe('a mixed installation', () => {
  it('is refused when two required packages disagree, and both releases are named', () => {
    const report = classifyInstallation(reader('0.1.5-rc.2', { '@deepseek-ai/dsh-fs-local': '0.1.6-alpha.1' }))
    expect(report.verdict).toBe('mixed')
    expect(report.release).toBeUndefined()
    expect(report.message).toContain('0.1.5-rc.2')
    expect(report.message).toContain('0.1.6-alpha.1')
  })

  it('is refused when an OPTIONAL package disagrees, not just a required one', () => {
    const report = classifyInstallation(reader('0.1.5-rc.2', { '@deepseek-ai/dsh-agent-instructions': '0.1.6-alpha.1' }))
    expect(report.verdict).toBe('mixed')
  })

  it('reports the inspected inventory so the odd package out is visible', () => {
    const report = classifyInstallation(reader('0.1.5-rc.2', { '@deepseek-ai/dsh-fs-local': '0.1.6-alpha.1' }))
    expect(report.message).toContain('@deepseek-ai/dsh-fs-local 0.1.6-alpha.1')
    expect(report.message).toContain('@deepseek-ai/dsh-sandbox-local 0.1.5-rc.2')
  })
})

describe('an unsupported release', () => {
  it('is refused even when every package agrees on it', () => {
    const report = classifyInstallation(reader('0.9.9'))
    expect(report.verdict).toBe('unsupported')
    expect(report.release).toBe('0.9.9')
  })

  it('names the installed release, the allowlist, and where to recover', () => {
    const report = classifyInstallation(reader('0.9.9'))
    expect(report.message).toContain('0.9.9')
    expect(report.message).toContain(SUPPORTED_DSH_RELEASES.join(', '))
    expect(report.message).toContain('docs/troubleshooting/unsupported-dsh-release.md')
  })

  it('is refused for a release BELOW the allowlist too, not just above it', () => {
    expect(classifyInstallation(reader('0.1.2-alpha.4')).verdict).toBe('unsupported')
  })
})

describe('the gate policy', () => {
  it('lets a supported installation through without a warning', () => {
    const report = classifyInstallation(reader(SUPPORTED_DSH_RELEASES[0]))
    expect(assertSupportedInstallation(report, 'enforce')).toBeUndefined()
  })

  it('refuses an unsupported installation under enforce, carrying the report', () => {
    const report = classifyInstallation(reader('0.9.9'))
    try {
      assertSupportedInstallation(report, 'enforce')
      expect.unreachable('the gate must refuse an unsupported installation')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DshCompatUnsupportedError)
      expect((error as DshCompatUnsupportedError).report).toBe(report)
      expect((error as Error).message).toContain('0.9.9')
    }
  })

  it('refuses a mixed installation under enforce', () => {
    const report = classifyInstallation(reader('0.1.5-rc.2', { '@deepseek-ai/dsh-fs-local': '0.1.6-alpha.1' }))
    expect(() => assertSupportedInstallation(report, 'enforce')).toThrow(DshCompatUnsupportedError)
  })

  it('warns instead of refusing under warn, and says the roots are unverified', () => {
    const report = classifyInstallation(reader('0.9.9'))
    const warning = assertSupportedInstallation(report, 'warn')
    expect(warning).toBeTypeOf('string')
    expect(warning).toContain('0.9.9')
    expect(warning).toContain('has not been verified')
    expect(warning).toContain('DSH_MULTI_ROOT_COMPAT=warn')
  })
})

describe('the gate is what the providers actually wait on', () => {
  it('is injected by every security-relevant row, so none can start without it', () => {
    for (const provider of [MultiRootFileSystem, MultiRootSandboxProvider, MultiRootRegistry]) {
      expect(provider.inject, provider.name).toContain('multiRootCompat')
    }
    expect(Instructions.inject).toContain('multiRootCompat')
  })

  it('leaves the fence and the sandbox unmounted while the service is absent', async () => {
    const fixture = createFixtureWorkspace('compat-gate')
    const ctx = new Context()
    const fibers = [
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService),
      await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }),
      await ctx.plugin(MultiRootSandboxProvider, { cwd: fixture.workspace }),
    ]
    try {
      // Cordis holds a row whose injected service is missing, so neither
      // provider ever claims its service key — the composition degrades to an
      // uninstalled harness instead of to an unguarded one.
      expect(ctx.get('fs')).toBeUndefined()
      expect(ctx.get('sandbox')).toBeUndefined()

      await mountCompat(ctx)
      expect(ctx.get('fs')).toBeDefined()
      expect(ctx.get('sandbox')).toBeDefined()
    } finally {
      while (fibers.length > 0) await fibers.pop()?.dispose()
      fixture.dispose()
    }
  })

  it('reports the release it started under once mounted', async () => {
    const ctx = new Context()
    await mountCompat(ctx)
    const report = classifyInstallation()
    expect(ctx.multiRootCompat.release).toBe(report.release)
    expect(ctx.multiRootCompat.supported).toBe(report.verdict === 'supported')
  })
})

describe('enforcement mode', () => {
  it('enforces by default', () => {
    expect(compatEnforcement({})).toBe('enforce')
  })

  it('relaxes only on the exact opt-in value', () => {
    expect(compatEnforcement({ DSH_MULTI_ROOT_COMPAT: 'warn' })).toBe('warn')
    for (const value of ['enforce', '', '1', 'true', 'WARN', 'warn ']) {
      expect(compatEnforcement({ DSH_MULTI_ROOT_COMPAT: value }), value).toBe('enforce')
    }
  })
})
