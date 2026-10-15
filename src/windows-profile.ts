/** Windows runner argv and capability identity. No Win32 calls at module load. */
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import {
  DialectUnrecognizedError,
  isWindowsNetworkOrDevicePath,
  parseWindowsProfile,
  assertWindowsDenyCapacity,
} from './windows-runner-contract.ts'

// The contract lives in windows-runner-contract.ts: lib/windows-runner.js runs
// as a separate Node process outside the host's plugin resolution, so its whole
// static module graph may import node builtins only. These re-exports keep the
// established import sites working unchanged.
export { parseWindowsProfile, workspaceScopeSid, type WindowsProfile } from './windows-runner-contract.ts'

/** Recognize the upstream runner, then select our ambient deny-token path. */
export function restrictWindowsProfile(profile: readonly string[], deniedRoots: readonly string[]): string[] {
  assertWindowsDenyCapacity(deniedRoots.length)
  if (profile.length < 2 || profile[0] === undefined || profile[1]?.startsWith('--')) {
    throw new DialectUnrecognizedError('Windows ACL runner invocation is not [node, runner, ...flags]')
  }
  const parsed = parseWindowsProfile(profile.slice(2))
  if (deniedRoots.length === 0) throw new DialectUnrecognizedError('Windows ambient restriction requires at least one deny root')
  for (const root of [parsed.workspace, ...deniedRoots]) {
    if (isWindowsNetworkOrDevicePath(root)) throw new DialectUnrecognizedError(`Windows ACL confinement cannot cover network or device paths: ${root}`)
  }
  return [profile[0], fileURLToPath(new URL('./windows-runner.js', import.meta.url)),
    '--upstream-runner', profile[1]!, '--workspace', parsed.workspace, '--temp', parsed.temp,
    '--mode', 'danger-full-access', ...deniedRoots.flatMap(root => ['--deny-root', root])]
}

export function widenWindowsProfile(
  profile: readonly string[],
  roots: readonly string[],
  deniedRoots: readonly string[],
  primaryRoot?: string,
): string[] {
  if (profile.length < 2 || profile[0] === undefined || profile[1]?.startsWith('--')) throw new DialectUnrecognizedError('Windows ACL runner invocation is not [node, runner, ...flags]')
  const parsed = parseWindowsProfile(profile.slice(2))
  // Fail closed (the caller converts this to SandboxUnavailableError): a UNC or
  // device root can never be widened into a profile, never run unconfined.
  for (const root of [parsed.workspace, ...roots]) {
    if (isWindowsNetworkOrDevicePath(root)) throw new DialectUnrecognizedError(`Windows ACL confinement cannot cover network or device paths: ${root}`)
  }
  if (primaryRoot !== undefined && canonicalPath(parsed.workspace) !== primaryRoot) throw new DialectUnrecognizedError('Windows ACL profile workspace does not match the policy root')
  // The restricted-token model grants; it cannot subtract. A denied root under
  // a granted directory (the workspace, the private temp, or a widened root)
  // stays writable through the parent's ACE — refuse the profile instead. The
  // registration rules keep ordinary members disjoint, but protected home
  // may contain the primary, and registered denies may contain a temp grant.
  {
    const granted = parsed.mode === 'workspace-write' ? [parsed.workspace, parsed.temp, ...roots] : roots
    const covered = deniedRoots.filter(root => granted.some(target =>
      windowsContained(root, target) || windowsContained(target, root)))
    if (covered.length > 0) {
      throw new DialectUnrecognizedError(
        `Windows ACL cannot deny [${covered.join(', ')}] inside a writable grant — the restricted-token model only grants`,
      )
    }
  }
  // With nothing to graft the upstream argv returns element for element — the
  // same passthrough as an empty scope.
  if (roots.length === 0) return [...profile]
  // The widened runner is OUR standalone file; it learns where the upstream
  // runner lives (--upstream-runner) because that location is the only anchor
  // from which @deepseek-ai/dsh-sandbox-windows-acl is importable — the plugin
  // install directory is not on its resolution path.
  return [
    profile[0],
    fileURLToPath(new URL('./windows-runner.js', import.meta.url)),
    '--upstream-runner', profile[1]!,
    ...profile.slice(2),
    ...roots.flatMap(root => ['--additional-root', root]),
  ]
}

/**
 * Containment over Windows SPELLINGS, not the host OS: the profile this
 * function rewrites may be produced for a Windows host while the check runs
 * in tests on POSIX, so the comparison cannot borrow the host's separator or
 * case rules.
 */
function windowsContained(candidate: string, root: string): boolean {
  const normalize = (path: string): string => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
  const target = normalize(candidate)
  const base = normalize(root)
  return target === base || target.startsWith(`${base}\\`)
}
