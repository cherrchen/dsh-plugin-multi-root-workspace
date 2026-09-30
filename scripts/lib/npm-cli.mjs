/** Invoke npm without a shell; Windows' npm.cmd is not an executable. */
import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

export function npmInvocation(args, platform = process.platform, nodePath = process.execPath) {
  if (platform !== 'win32') return { file: 'npm', args }
  const cli = win32.join(win32.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { file: nodePath, args: [cli, ...args] }
}

export function npmOutput(args) {
  const invocation = npmInvocation(args)
  return execFileSync(invocation.file, invocation.args, { encoding: 'utf8' })
}
