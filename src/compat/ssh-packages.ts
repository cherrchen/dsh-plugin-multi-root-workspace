/** Evaluate the exact SSH entries selected by the Host/Profile capability gate. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { insidePackageRoot, pluginPackageRoot, SSH_PEER_PACKAGES, type SshCapability } from './dsh-version.ts'
import { installClientPskFallback, PSK_FALLBACK_CIPHERS, UPSTREAM_PSK_CIPHER } from './ssh-stream-ciphers.ts'

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
  // `@deepseek-ai/dsh-ssh` binds `tls.connect` when it is evaluated. A
  // BoringSSL Host cannot create the suite it requests, so the fallback must
  // be installed before the first import; see src/compat/ssh-stream-ciphers.ts.
  const psk = installClientPskFallback()
  if (psk.plan.kind === 'unsupported') {
    throw new Error(`SSH stream TLS is unavailable on this runtime: neither ${UPSTREAM_PSK_CIPHER} nor ${PSK_FALLBACK_CIPHERS.join(', ')} is implemented`)
  }
  const require = createRequire(import.meta.url)
  const anchor = gate.locations === undefined ? require.resolve('@deepseek-ai/dsh/package.json') : undefined
  const hostRequire = anchor === undefined ? undefined : createRequire(anchor)
  const root = pluginPackageRoot(require)
  const anchoredInside = anchor !== undefined && insidePackageRoot(anchor, root)
  const modules: HostSshPackages = {}
  for (const name of SSH_PEER_PACKAGES) {
    const resolved = gate.locations?.[name]?.entry ?? hostRequire?.resolve(name)
    if (resolved === undefined) throw new Error(`SSH package resolution is unavailable: ${name}`)
    if (gate.locations === undefined && !anchoredInside && insidePackageRoot(resolved, root)) {
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
