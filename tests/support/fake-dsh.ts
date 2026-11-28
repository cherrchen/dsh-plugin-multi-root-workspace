import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const release = '0.2.2-rc.5'

export function fakeDsh(root: string, options: { release?: string; fail?: boolean; skip?: string; noEntry?: string; noisyFailure?: boolean; hang?: boolean; treeHang?: boolean; detachedHang?: boolean } = {}): string {
  const path = join(root, 'fake dsh.mjs')
  const hangs = options.hang === true || options.treeHang === true || options.detachedHang === true
  const spawnsGrandchild = options.treeHang === true || options.detachedHang === true
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
const log = process.env.FAKE_LOG
const argsLog = process.env.FAKE_ARGS_LOG
const pidLog = process.env.FAKE_PID_LOG
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(options.release ?? release)} + '\\n'); process.exit(0) }
if (${hangs ? 'true' : 'false'}) {
if (${spawnsGrandchild ? 'true' : 'false'}) {
  // A package manager that keeps the inherited output pipes open after the
  // CLI itself is dead; it ignores SIGTERM, so only an escalated SIGKILL can
  // end it. In detached mode it additionally leaves the CLI's process group.
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'inherit', detached: ${options.detachedHang === true ? 'true' : 'false'} })
  if (pidLog !== undefined) appendFileSync(pidLog, String(grandchild.pid) + '\\n')
}
setInterval(() => {}, 1000)
}
else {
const profile = args[args.indexOf('--profile') + 1]
const home = process.env.DSH_HOME
const dir = join(home, 'profiles', profile)
mkdirSync(dir, { recursive: true })
const dependencies = {}
for (const arg of args) {
  if (!arg.startsWith('@deepseek-ai/')) continue
  const at = arg.lastIndexOf('@')
  const name = arg.slice(0, at)
  if (name === ${JSON.stringify(options.skip ?? '')}) continue
  const pkgRoot = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name, version: arg.slice(at + 1), main: './index.js' }))
  if (name !== ${JSON.stringify(options.noEntry ?? '')}) writeFileSync(join(pkgRoot, 'index.js'), 'module.exports = {}')
  dependencies[name] = arg.slice(at + 1)
}
writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
if (${options.noisyFailure === true ? 'true' : 'false'}) process.stderr.write('x'.repeat(8300) + 'SECRET_TOKEN_SHOULD_NOT_CROSS')
if (log !== undefined) appendFileSync(log, 'add\\n')
if (argsLog !== undefined) appendFileSync(argsLog, JSON.stringify(args) + '\\n')
process.exit(${options.fail === true ? 1 : 0})
}
`, { mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return path
}
