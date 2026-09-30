import { describe, expect, it } from 'vitest'
import { npmInvocation } from '../scripts/lib/npm-cli.mjs'

describe('npm subprocess invocation', () => {
  it('uses the executable on POSIX', () => {
    expect(npmInvocation(['view', '@deepseek-ai/dsh', 'versions', '--json'], 'darwin'))
      .toEqual({ file: 'npm', args: ['view', '@deepseek-ai/dsh', 'versions', '--json'] })
  })

  it('runs the bundled npm CLI with Node on Windows, preserving argument boundaries', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const args = ['view', '@deepseek-ai/dsh@0.2.0-rc.2', 'dependencies.@deepseek-ai/cordis', '--json']
    expect(npmInvocation(args, 'win32', node)).toEqual({
      file: node,
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', ...args],
    })
  })
})
