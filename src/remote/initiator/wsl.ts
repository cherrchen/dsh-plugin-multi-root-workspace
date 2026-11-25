import { TextDecoder } from 'node:util'
import { win32 } from 'node:path'
import { windowsSystem32 } from './windows-openssh.ts'
import { isWslDistributionName } from './identity.ts'

export function wslExecutable(systemRoot?: string): string {
  return win32.join(windowsSystem32(systemRoot), 'wsl.exe')
}

/** Parse only successful `--list --quiet` stdout, not a localized error or the verbose table. */
export function parseWslDistributions(stdout: Uint8Array): readonly string[] {
  const bom = stdout[0] === 255 && stdout[1] === 254
  // Without a BOM, look for the UTF-16LE separator or the high byte of an ASCII character.
  const wide = bom || (stdout.length % 2 === 0 && stdout.some((byte, index) =>
    (index % 2 === 0 && byte === 10 && stdout[index + 1] === 0) || (index % 2 === 1 && byte === 0)))
  const text = new TextDecoder(wide ? 'utf-16le' : 'utf-8', { fatal: true }).decode(stdout)
  const names = text.split(/\r?\n/u).filter(name => name !== '')
  if (!names.every(isWslDistributionName) || new Set(names).size !== names.length) {
    throw new Error('WSL distribution list is malformed')
  }
  return names
}

export function wslExecArgs(
  distributions: readonly string[], selected: string, command: readonly [string, ...string[]],
): string[] {
  if (!isWslDistributionName(selected) || !distributions.includes(selected)) {
    throw new Error('Selected WSL distribution is not installed')
  }
  return ['--distribution', selected, '--exec', ...command]
}
