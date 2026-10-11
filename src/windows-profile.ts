/** Windows runner argv and capability identity. No Win32 calls at module load. */
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import {
  DialectUnrecognizedError,
  isWindowsNetworkOrDevicePath,
  parseWindowsProfile,
} from './windows-runner-contract.ts'

// The contract lives in windows-runner-contract.ts: lib/windows-runner.js runs
// as a separate Node process outside the host's plugin resolution, so its whole
// static module graph may import node builtins only. These re-exports keep the
// established import sites working unchanged.
export { parseWindowsProfile, workspaceScopeSid, type WindowsProfile } from './windows-runner-contract.ts'

export function widenWindowsProfile(profile: readonly string[], roots: readonly string[], primaryRoot?: string): string[] {
  if (profile.length < 2 || profile[0] === undefined || profile[1]?.startsWith('--')) throw new DialectUnrecognizedError('Windows ACL runner invocation is not [node, runner, ...flags]')
  const parsed = parseWindowsProfile(profile.slice(2))
  // Fail closed (the caller converts this to SandboxUnavailableError): a UNC or
  // device root can never be widened into a profile, never run unconfined.
  for (const root of [parsed.workspace, ...roots]) {
    if (isWindowsNetworkOrDevicePath(root)) throw new DialectUnrecognizedError(`Windows ACL confinement cannot cover network or device paths: ${root}`)
  }
  if (primaryRoot !== undefined && canonicalPath(parsed.workspace) !== primaryRoot) throw new DialectUnrecognizedError('Windows ACL profile workspace does not match the policy root')
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
