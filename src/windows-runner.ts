/**
 * Standalone runner: public upstream AclSandbox with a capability for the
 * whole root set.
 *
 * This file is built into `lib/windows-runner.js` and executed as a SEPARATE
 * Node process. The host's in-process plugin package resolution does not
 * apply there, so this module (and everything it statically imports — only
 * `windows-runner-contract.ts`) may import `node:` builtins exclusively. The
 * upstream ACL package is reached dynamically through `--upstream-runner`:
 * `createRequire(<upstream runner>).resolve('@deepseek-ai/dsh-sandbox-windows-acl')
 * resolves the package by self-reference from its own install location — the
 * one anchor guaranteed to see it.
 */
import { closeSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalPath, isWindowsNetworkOrDevicePath, parseWindowsProfile, workspaceScopeSid } from './windows-runner-contract.ts'

async function main(): Promise<number> {
  if (process.platform !== 'win32') throw new Error('Windows ACL runner requires Windows')
  const raw = process.argv.slice(2)
  const separator = raw.indexOf('--')
  if (separator < 0 || raw[separator + 1] === undefined) throw new Error('missing command after --')
  const profile = parseWindowsProfile(raw.slice(0, separator), true)
  // Under `workspace-write` the grant set is the workspace plus every
  // additional root. Under `read-only` (B9's fixed `read-write` cell) the
  // grant set is the additional roots ALONE: the workspace-write token is what
  // expresses "only these dirs writable", the workspace itself staying denied.
  const roots = profile.mode === 'read-only'
    ? [...new Set(profile.additionalRoots)]
    : [...new Set([profile.workspace, ...profile.additionalRoots])]
  const verifyRoots = (): void => {
    for (const root of roots) {
      if (isWindowsNetworkOrDevicePath(root)) throw new Error(`Windows ACL confinement cannot cover network or device paths: ${root}`)
      if (!statSync(root).isDirectory() || canonicalPath(root) !== root) throw new Error(`workspace root was removed or redirected: ${root}`)
    }
  }
  verifyRoots()
  if (!existsSync(profile.temp) || !statSync(profile.temp).isDirectory()) throw new Error(`--temp is not an existing directory: ${profile.temp}`)
  // Resolution and import both fail loudly (exit 127, `windows-acl-run:`) when
  // the upstream runner's location can no longer see its own package.
  const aclEntry = createRequire(profile.upstreamRunner!).resolve('@deepseek-ai/dsh-sandbox-windows-acl')
  const { AclSandbox, assertTempRootOutsideWorkspace, workspaceWriteSid, tempWriteSid } = await import(pathToFileURL(aclEntry).href)
  if (profile.writeSid !== undefined && (profile.writeSid !== workspaceWriteSid(profile.workspace) || profile.tempWriteSid !== tempWriteSid(profile.temp))) {
    throw new Error('upstream capability SIDs do not match their paths')
  }
  for (const root of roots) assertTempRootOutsideWorkspace(root, profile.temp)
  // Own a new private temp capability even when upstream already owns a session
  // temp — read-only mode grants no temp at all (`tempDir: null`), matching the
  // upstream mode meaning.
  const temp = profile.mode === 'workspace-write' ? mkdtempSync(join(profile.temp, 'dsh-multi-root-')) : null
  const sandbox = new AclSandbox({
    writableDirs: roots,
    tempDir: temp,
    writeSid: workspaceScopeSid(roots),
    ...(temp === null ? {} : { tempWriteSid: tempWriteSid(temp) }),
    mode: 'workspace-write',
  })
  let initialized = false
  try {
    await sandbox.init()
    initialized = true
    // Narrow the swap window between the pre-check and the ACE grant: a root
    // replaced between the two must not be confined under its new target.
    verifyRoots()
    // Update the native environment block inherited by CreateProcessAsUserW.
    if (temp !== null) {
      process.env.TMP = temp
      process.env.TEMP = temp
    }
    // Keep the runner alive while its console-sharing child handles Ctrl+C.
    process.on('SIGINT', () => {})
    const control = process.env.DSH_SUBPROCESS_CONTROL === 'pipe'
    const child = sandbox.spawn({ command: raw[separator + 1]!, args: raw.slice(separator + 2), stdio: 'inherit', ...(control ? { controlFileDescriptor: 7 as const } : {}) })
    if (control) closeSync(7)
    return (await child.wait()).exitCode
  } finally {
    // Match the upstream runner: cleanup diagnostics must not mask a child exit code.
    try { if (initialized) sandbox.dispose() }
    catch (error) { reportCleanup(error) }
    try { if (temp !== null) rmSync(temp, { recursive: true, force: true }) }
    catch (error) { reportCleanup(error) }
  }
}

function reportCleanup(error: unknown): void {
  process.stderr.write(`windows-acl-run: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
}

main().then(code => { process.exitCode = code }, (error: unknown) => {
  process.stderr.write(`windows-acl-run: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 127
})
