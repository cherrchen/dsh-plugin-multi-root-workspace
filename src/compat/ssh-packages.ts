/**
 * The optional SSH peers are loaded ONLY through the `@deepseek-ai/dsh` host
 * anchor — the copy the composition mounts — and only behind an `eligible`
 * capability gate. Unlike `loadHostKoffi()` there is NO fallback to a
 * package-local copy: when the anchor cannot see a package it is absent, and
 * an anchor whose own tree is outside this package's root resolving INTO that
 * root is a private copy and an identity mismatch.
 *
 * The SSH environment manager (`src/remote/ssh-environment.ts`) is the only
 * importer, behind the `eligible` capability gate. No class is ever
 * constructed here.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { insidePackageRoot, pluginPackageRoot, SSH_PEER_PACKAGES, type SshCapability } from './dsh-version.ts'

/** The public class each SSH package must expose on rc.1 (ADR-0032 verified). */
const PACKAGE_EXPORTS: Record<string, string> = {
  '@deepseek-ai/dsh-ssh': 'SshConnection',
  '@deepseek-ai/dsh-fs-ssh': 'SshFileSystem',
  '@deepseek-ai/dsh-subprocess-ssh': 'SshSubprocessRuntime',
  '@deepseek-ai/dsh-sandbox-ssh': 'SshSandboxProvider',
}

/** The four module namespaces, keyed by package name. */
export type HostSshPackages = Record<string, unknown>

/**
 * Resolve and evaluate each SSH package through the host anchor, verifying
 * only that the expected class exists — nothing is instantiated.
 * @param gate - the {@link SshCapability} verdict; anything but `eligible` refuses.
 * @param importer - the module loader (injectable for tests).
 * @returns the module namespaces keyed by package name.
 */
export async function loadHostSshPackages(
  gate: SshCapability,
  importer: (url: string) => Promise<unknown> = url => import(url),
): Promise<HostSshPackages> {
  if (gate.status !== 'eligible') {
    throw new Error(`SSH capability is not eligible${gate.status === 'absent' ? ` (${gate.reason}: ${gate.detail})` : ''}`)
  }
  const require = createRequire(import.meta.url)
  const anchor = require.resolve('@deepseek-ai/dsh/package.json')
  const hostRequire = createRequire(anchor)
  const root = pluginPackageRoot(require)
  const anchoredInside = insidePackageRoot(anchor, root)
  const modules: HostSshPackages = {}
  for (const name of SSH_PEER_PACKAGES) {
    const resolved = hostRequire.resolve(name)
    if (!anchoredInside && insidePackageRoot(resolved, root)) {
      throw new Error(`identity-mismatch: ${name} resolves inside this package's own tree`)
    }
    const ns = await importer(pathToFileURL(resolved).href) as Record<string, unknown> & { default?: Record<string, unknown> }
    const expected = PACKAGE_EXPORTS[name]!
    const candidate = ns[expected] ?? ns.default?.[expected]
    if (typeof candidate !== 'function') {
      throw new Error(`identity-mismatch: ${name} does not export ${expected}`)
    }
    modules[name] = ns
  }
  return modules
}
