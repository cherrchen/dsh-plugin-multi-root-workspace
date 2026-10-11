import { execFileSync } from 'node:child_process'

/**
 * The volume's 8.3 short name for `path`, resolved by `cmd`'s `%~sI` modifier.
 * `windowsVerbatimArguments` keeps Node from re-quoting the inner quotes —
 * escaped quotes reach `cmd` as `D:\"...\"` and the lookup resolves garbage.
 * `/s` is deliberately absent: it would strip the first and last quote.
 * Returns the path unchanged on volumes where 8.3 generation is off.
 */
export function shortPathName(path: string): string {
  return execFileSync('cmd', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).trim()
}
