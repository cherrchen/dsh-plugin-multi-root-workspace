import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const release = '0.2.2-rc.5'

export function fakeDsh(root: string, options: { release?: string; fail?: boolean; skip?: string; noEntry?: string; noisyFailure?: boolean } = {}): string {
  const path = join(root, 'fake dsh.mjs')
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const log = process.env.FAKE_LOG
const argsLog = process.env.FAKE_ARGS_LOG
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(options.release ?? release)} + '\\n'); process.exit(0) }
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
`, { mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return path
}
