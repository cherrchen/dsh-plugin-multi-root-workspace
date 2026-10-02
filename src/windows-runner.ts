/** Standalone runner: public upstream AclSandbox with a capability for the whole root set. */
import { closeSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { parseWindowsProfile, workspaceScopeSid } from './windows-profile.ts'

async function main(): Promise<number> {
  if (process.platform !== 'win32') throw new Error('Windows ACL runner requires Windows')
  const raw = process.argv.slice(2)
  const separator = raw.indexOf('--')
  if (separator < 0 || raw[separator + 1] === undefined) throw new Error('missing command after --')
  const profile = parseWindowsProfile(raw.slice(0, separator), true)
  const roots = [...new Set([profile.workspace, ...profile.additionalRoots])]
  for (const root of roots) {
    if (!statSync(root).isDirectory() || canonicalPath(root) !== root) throw new Error(`workspace root was removed or redirected: ${root}`)
  }
  const { AclSandbox, assertTempRootOutsideWorkspace, workspaceWriteSid, tempWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl')
  if (profile.writeSid !== undefined && (profile.writeSid !== workspaceWriteSid(profile.workspace) || profile.tempWriteSid !== tempWriteSid(profile.temp))) {
    throw new Error('upstream capability SIDs do not match their paths')
  }
  for (const root of roots) assertTempRootOutsideWorkspace(root, profile.temp)
  // Own a new private temp capability even when upstream already owns a session temp.
  const temp = mkdtempSync(join(profile.temp, 'dsh-multi-root-'))
  const sandbox = new AclSandbox({ writableDirs: roots, tempDir: temp, writeSid: workspaceScopeSid(roots), tempWriteSid: tempWriteSid(temp), mode: 'workspace-write' })
  let initialized = false
  try {
    await sandbox.init()
    initialized = true
    // Update the native environment block inherited by CreateProcessAsUserW.
    process.env.TMP = temp
    process.env.TEMP = temp
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
    try { rmSync(temp, { recursive: true, force: true }) }
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
