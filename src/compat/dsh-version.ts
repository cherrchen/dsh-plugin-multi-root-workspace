/**
 * The DSH compatibility contract: which upstream releases this plugin is
 * actually verified against, and how an installation is judged against that
 * list.
 *
 * This module is the ONE place the support matrix is spelled out. It is
 * deliberately pure — no cordis, no logging, no process exit — so that the
 * runtime gate (`src/compat.ts`), the static gate (`scripts/check-dsh-compat.mjs`)
 * and the tests all judge an installation by the same code instead of three
 * drifting copies of the same list.
 *
 * Why a contract exists at all: this plugin replaces `ctx.fs` and `ctx.sandbox`
 * with subclasses of the upstream providers, and `src/dialects.ts` recognizes
 * the kernel-sandbox profile by OBSERVING the argv shape `super.confine`
 * produced (ADR-0003). Both couplings are to pre-stable upstream internals that
 * carry no semver promise. An npm range like `>=0.1.2-alpha.4 <0.2.0` therefore
 * promises far more than the code was ever verified against; the allowlist
 * below promises exactly what CI has run.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/dsh-version
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The releases this plugin is verified against, as EXACT version strings.
 *
 * Not a semver range, on purpose: a range is a prediction about releases that
 * do not exist yet, and this plugin's coupling to upstream argv shapes makes
 * that prediction unsafe. Adding an entry is always a human act performed after
 * the upgrade smoke passed on that exact version — a green CI run on an
 * unlisted release is evidence, not authorization (ADR-0009).
 */
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2'] as const

/** One release this plugin claims to support. */
export type SupportedDshRelease = typeof SUPPORTED_DSH_RELEASES[number]

/**
 * Packages whose absence means this plugin cannot function at all: every one of
 * them is either subclassed, imported for a value, or the owner of a service
 * key the providers inject.
 */
export const REQUIRED_CORE_PACKAGES = [
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-storage-domain',
] as const

/**
 * Packages a full composition provides and a minimal one legitimately omits.
 * Absence is fine; a version that DISAGREES with the required packages is not —
 * that is the mixed-installation failure this contract exists to catch.
 */
export const OPTIONAL_CORE_PACKAGES = [
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-query',

  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-working-directory',
  '@deepseek-ai/dsh-lsp',
  '@deepseek-ai/dsh-lsp-stdio',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
] as const

/**
 * The optional packages this plugin loads itself at run time, through dynamic
 * `import()`s inside this package's own modules. The copy this module resolves
 * IS the copy that would execute, so every resolvable hit testifies — a
 * private copy inside this package's own tree genuinely loads, and a version
 * that disagrees with the host is a real mixed installation, not a phantom.
 */
export const RUNTIME_OPTIONAL_PACKAGES = [
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-typert-protocol',
] as const

/**
 * The optional packages this plugin consumes only as mounted host services or
 * ambient types — it never imports them, so a copy inside this package's own
 * tree can never execute. The only version that testifies is the one the
 * COMPOSITION resolves (the installation or the profile): a resolution that
 * lands inside this package's own root is a private development or bundled
 * copy and must be reported absent — otherwise a `link:`-installed checkout
 * whose devDependencies carry a newer release phantom-mixes every supported
 * host it is developed against (the report that motivated this split:
 * `dsh-lsp`/`dsh-lsp-stdio`/`dsh-working-directory` resolving to the plugin's
 * devDependencies on a `0.2.0-rc.2` host produced a `mixed` verdict on a
 * uniformly `0.2.0-rc.2` installation).
 */
export const HOST_SERVICE_PACKAGES = [
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-query',

  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-lsp',
  '@deepseek-ai/dsh-lsp-stdio',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-working-directory',
] as const

/**
 * Optional packages this plugin executes that are resolved through an anchor
 * OTHER than this module. The standalone Windows ACL runner
 * (`src/windows-runner.ts`) imports `@deepseek-ai/dsh-sandbox-windows-acl` by
 * self-reference from the upstream runner's own install location — a file the
 * installed `dsh-sandbox-local` points at in its confined argv — so the copy
 * that testifies is the one sibling to that required package, not whatever
 * this module can reach. Neither the self-resolution hit nor the
 * `@deepseek-ai/dsh` host anchor reflects execution here: if sandbox-local's
 * own anchor cannot see the package, the runner cannot load it either, and
 * absent is the honest answer.
 */
export const RUNNER_ANCHORED_PACKAGES = [
  '@deepseek-ai/dsh-sandbox-windows-acl',
] as const

/** The required package whose tree produces the upstream runner argv. */
const RUNNER_ANCHOR_PACKAGE = '@deepseek-ai/dsh-sandbox-local'

/** Every package the contract inspects, required first. */
export const CORE_PACKAGES = [...REQUIRED_CORE_PACKAGES, ...OPTIONAL_CORE_PACKAGES] as const

/** How this plugin reacts to an installation it does not support. */
export type CompatEnforcement = 'enforce' | 'warn'

/** The environment variable that relaxes the gate. */
export const COMPAT_ENFORCEMENT_ENV = 'DSH_MULTI_ROOT_COMPAT'

/** One inspected package and the version actually resolved for it. */
export interface InspectedPackage {
  /** The package specifier. */
  readonly name: string
  /** The resolved `version`, or `undefined` when the package is not installed. */
  readonly version: string | undefined
  /** Whether absence alone is a failure. */
  readonly required: boolean
}

/**
 * Why an installation was accepted or rejected.
 *
 * - `supported` — one release, and it is on the allowlist.
 * - `incomplete` — a required package could not be resolved.
 * - `mixed` — the installed core packages do not agree on one release.
 * - `unsupported` — one release, but not on the allowlist.
 */
export type CompatVerdict = 'supported' | 'incomplete' | 'mixed' | 'unsupported'

/** The judgement passed on one installation. */
export interface CompatReport {
  /** The verdict. */
  readonly verdict: CompatVerdict
  /** The single release every inspected package agreed on; absent unless they did. */
  readonly release: string | undefined
  /** Every inspected package, in {@link CORE_PACKAGES} order. */
  readonly packages: readonly InspectedPackage[]
  /** Operator-facing explanation, ready to log or print verbatim. */
  readonly message: string
}

/** Reads the installed version of one package, or `undefined` when absent. */
export type VersionReader = (packageName: string) => string | undefined

/**
 * Resolve one package's `package.json` path through a require, or `undefined`
 * when it cannot be resolved. The path — not just the version — matters: the
 * caller needs to know WHERE the copy lives to judge whether it belongs to the
 * inspected installation.
 * @param require - the require to resolve through.
 * @param packageName - the package to locate.
 * @returns the manifest path, or `undefined`.
 */
function resolvePackageJson(require: NodeRequire, packageName: string): string | undefined {
  try {
    return require.resolve(`${packageName}/package.json`)
  } catch {
    return undefined
  }
}

/** Read `version` off a resolved manifest path; a broken manifest is absent. */
function versionOfManifest(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The second resolution anchor: a require rooted at the installed
 * `@deepseek-ai/dsh` meta package. Host-internal packages that never appear as
 * plugin peers are only reachable this way (the pattern the retired
 * `HOST_RESOLVED_PACKAGES` list carved out for `dsh-working-directory`,
 * generalized here to every host-service package).
 * @param require - this module's require, used to locate the meta package.
 * @returns the host-rooted require, or `undefined` when `dsh` itself cannot be
 *   resolved.
 */
function hostAnchorRequire(require: NodeRequire): NodeRequire | undefined {
  const anchor = resolvePackageJson(require, '@deepseek-ai/dsh')
  return anchor === undefined ? undefined : createRequire(anchor)
}

/**
 * This package's own install root — the boundary between a copy that belongs
 * to the inspected installation and a private copy only this package can see.
 * @param require - this module's require; self-reference through the package's
 *   `exports` is tried first, then a walk up from this module's file.
 * @returns the package root, or `undefined` when neither anchor works.
 */
function pluginPackageRoot(require: NodeRequire): string | undefined {
  try {
    return dirname(require.resolve('@dsh-electron/dsh-plugin-multi-root-workspace/package.json'))
  } catch {
    let dir = dirname(fileURLToPath(import.meta.url))
    while (true) {
      if (existsSync(join(dir, 'package.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }
}

/**
 * Whether a resolved manifest path lives inside this package's own root — the
 * mark of a private copy no composition can mount. An unknown root cannot
 * exclude anything, so it answers `false` rather than guessing.
 */
function insidePackageRoot(manifestPath: string, root: string | undefined): boolean {
  return root !== undefined && (manifestPath === root || manifestPath.startsWith(`${root}${sep}`))
}

/**
 * Read one package's declared version through Node resolution.
 *
 * Resolution runs from THIS module — for required and runtime-loaded packages
 * the copy found here is the copy that would execute, which is what makes the
 * answer meaningful: the upstream packages are peer dependencies, so they
 * resolve to the single copy the host provides — the same copy the providers
 * will subclass at runtime.
 *
 * {@link HOST_SERVICE_PACKAGES} are different: the plugin never imports them,
 * so a copy inside this package's own tree can never execute, and counting it
 * would report a mixed installation out of a linked checkout's devDependencies
 * alone. Only a hit OUTSIDE this package's root — a copy the composition could
 * mount — testifies; when this module cannot reach the package at all, the
 * `@deepseek-ai/dsh` host manifest supplies a second anchor for host-internal
 * packages that are never plugin peers.
 *
 * {@link RUNNER_ANCHORED_PACKAGES} are a third policy: executed, but resolved
 * from the upstream-runner anchor rather than this module, so only a hit
 * sibling to the installed `dsh-sandbox-local` testifies.
 *
 * A package that cannot be resolved in either place is reported absent rather
 * than throwing, because "not installed" is a legitimate answer for every
 * optional package.
 * @param packageName - the package to inspect.
 * @returns the declared version, or `undefined` when the package or its
 *   manifest cannot be resolved.
 */
export function readInstalledVersion(packageName: string): string | undefined {
  const require = createRequire(import.meta.url)
  if ((RUNNER_ANCHORED_PACKAGES as readonly string[]).includes(packageName)) {
    // Whatever the anchor resolves IS the copy the runner loads — the anchor
    // chain is the executor chain, so the plugin-root exclusion does not
    // apply. A miss means the runner cannot load the package, which is absent.
    const anchor = resolvePackageJson(require, RUNNER_ANCHOR_PACKAGE)
    const hit = anchor === undefined ? undefined : resolvePackageJson(createRequire(anchor), packageName)
    return hit === undefined ? undefined : versionOfManifest(hit)
  }
  if (!(HOST_SERVICE_PACKAGES as readonly string[]).includes(packageName)) {
    const hit = resolvePackageJson(require, packageName)
    return hit === undefined ? undefined : versionOfManifest(hit)
  }
  const root = pluginPackageRoot(require)
  const selfHit = resolvePackageJson(require, packageName)
  if (selfHit !== undefined && !insidePackageRoot(selfHit, root)) return versionOfManifest(selfHit)
  const host = hostAnchorRequire(require)
  const hostHit = host === undefined ? undefined : resolvePackageJson(host, packageName)
  return hostHit === undefined || insidePackageRoot(hostHit, root) ? undefined : versionOfManifest(hostHit)
}

/**
 * Judge one installation against the contract.
 *
 * The three checks run in this order, and the first failure wins, because each
 * later check would report nonsense about an installation that failed an
 * earlier one: a missing required package has no version to compare, and a
 * mixed installation has no single version to look up in the allowlist.
 * @param readVersion - version reader; defaults to Node resolution. Tests and
 *   the static checker pass their own.
 * @returns the report; never throws.
 */
export function classifyInstallation(readVersion: VersionReader = readInstalledVersion): CompatReport {
  const packages: InspectedPackage[] = CORE_PACKAGES.map(name => ({
    name,
    version: readVersion(name),
    required: (REQUIRED_CORE_PACKAGES as readonly string[]).includes(name),
  }))

  const missing = packages.filter(entry => entry.required && entry.version === undefined)
  if (missing.length > 0) {
    return report('incomplete', undefined, packages, [
      'multi-root workspace: required DSH packages are not installed.',
      '',
      ...missing.map(entry => `  missing: ${entry.name}`),
    ])
  }

  const releases = [...new Set(packages.flatMap(entry => (entry.version === undefined ? [] : [entry.version])))].sort()
  const [release, ...extra] = releases
  if (release === undefined) {
    // Unreachable while REQUIRED_CORE_PACKAGES is non-empty: the missing check
    // above already returned. Kept so the type narrows without a cast.
    return report('incomplete', undefined, packages, ['multi-root workspace: no DSH package could be inspected.'])
  }
  if (extra.length > 0) {
    return report('mixed', undefined, packages, [
      'multi-root workspace: this installation mixes several DSH releases.',
      '',
      'The filesystem fence and the kernel-sandbox dialects must agree on one upstream',
      'release; a mixed installation means one half of the sandbox was verified against a',
      'shape the other half no longer produces. Align every @deepseek-ai/dsh* package on',
      'one release.',
      '',
      `  releases found: ${releases.join(', ')}`,
    ])
  }
  if (!(SUPPORTED_DSH_RELEASES as readonly string[]).includes(release)) {
    return report('unsupported', release, packages, [
      `multi-root workspace: DSH ${release} is not a supported release.`,
      '',
      'This plugin replaces the workspace filesystem fence and the kernel-sandbox provider,',
      'and it recognizes the sandbox profile by the argv shape the upstream provider produces.',
      'Upstream makes no semver promise, so the plugin refuses to grant additional roots on a',
      'release it has never been verified against rather than guess at that shape.',
      '',
      `  supported: ${SUPPORTED_DSH_RELEASES.join(', ')}`,
      `  installed: ${release}`,
    ])
  }
  return report('supported', release, packages, [`multi-root workspace: DSH ${release} is a supported release.`])
}

/**
 * Read the enforcement mode.
 *
 * `warn` exists for exactly one caller: the upgrade smoke, which must run the
 * whole behavior matrix against a release that is deliberately NOT on the
 * allowlist yet — that run is how a release earns its place on the list. It is
 * not a production escape hatch, and the warning says so.
 * @param env - the environment to read; defaults to this process's.
 * @returns `warn` only when explicitly requested, `enforce` otherwise.
 */
export function compatEnforcement(env: Record<string, string | undefined> = process.env): CompatEnforcement {
  return env[COMPAT_ENFORCEMENT_ENV] === 'warn' ? 'warn' : 'enforce'
}

/** Compose a report, appending the package inventory and the recovery pointer. */
function report(
  verdict: CompatVerdict,
  release: string | undefined,
  packages: readonly InspectedPackage[],
  lines: readonly string[],
): CompatReport {
  const body = verdict === 'supported'
    ? [...lines]
    : [
        ...lines,
        '',
        'Inspected packages:',
        ...packages.map(entry => `  ${entry.name} ${entry.version ?? '(not installed)'}`),
        '',
        'See docs/troubleshooting/unsupported-dsh-release.md',
      ]
  return { verdict, release, packages, message: body.join('\n') }
}
