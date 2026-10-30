/** Structural runner recognition shared by the synchronous process seams. */
import { detectDialect } from '../dialects.ts'

export function hasConfinedProfile(argv: readonly string[]): boolean {
  return argv.includes('--ro-bind') || (argv.includes('--ro') && argv.includes('--rw'))
    || (argv.includes('--workspace') && argv.includes('--mode'))
    || (argv.includes('-p') && argv.some(arg => arg.includes('(version 1)')))
}

/** Agent PTYs are re-confined after their own fresh admission, never replayed. */
export function originalProcessArgv(argv: readonly string[]): readonly string[] {
  if (!hasConfinedProfile(argv)) return argv
  const separator = argv.indexOf('--')
  if (separator < 1 || separator === argv.length - 1) throw new Error('unrecognized confined terminal argv')
  detectDialect(argv.slice(0, separator))
  return argv.slice(separator + 1)
}
