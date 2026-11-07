/**
 * The SBPL spelling of a subpath literal — backslashes and quotes escaped.
 *
 * A Seatbelt profile built from a Windows path doubles every backslash (the
 * upstream provider's `sbplString` does the same), so a spec comparing profile
 * text must compare the escaped spelling on every platform.
 *
 * @module tests/support/sbpl
 */

export function sbplSubpath(path: string): string {
  return `(subpath "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`
}
