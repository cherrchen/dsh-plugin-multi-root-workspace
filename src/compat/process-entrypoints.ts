/**
 * Compatibility adapter: which public executor entries the mounted process
 * services expose.
 *
 * The process fence (`src/process-fence.ts`) wraps the entries through which
 * a `danger-full-access` call can spawn an ambient subprocess. Which of them
 * exist is a per-release shape — `execute` is the shell executor's only entry
 * on current releases while `start` existed through 0.1.6, and the PTC
 * runtime's public seam is `run` (its `execute` helper is private to the
 * concrete runtime and is deliberately never a cross-package seam). The fence
 * therefore asks this module, structurally, which entries the MOUNTED service
 * actually carries — never a version string.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/process-entrypoints
 */

/** A public shell/executor entry the process fence can wrap. */
export type ProcessEntrypoint = 'execute' | 'run' | 'start'

/**
 * The public shell executor entries present on the mounted service, in this
 * order: `execute`, `run`, `start` (`start` existed through 0.1.6).
 * @param shell - the mounted `ctx.shell` service.
 * @returns the present entries — a structural probe only.
 */
export function shellEntrypoints(shell: object): readonly ProcessEntrypoint[] {
  const record = shell as Partial<Record<ProcessEntrypoint, unknown>>
  return (['execute', 'run', 'start'] as const).filter(key => typeof record[key] === 'function')
}

/**
 * The PTC runtime's public entry: `['run']` when it is a function; never the
 * concrete runtime's private `execute` helper.
 * @param runtime - the mounted `ctx.ptcRuntime` service.
 * @returns the present entries — a structural probe only.
 */
export function ptcEntrypoints(runtime: object): readonly ProcessEntrypoint[] {
  const record = runtime as Partial<Record<ProcessEntrypoint, unknown>>
  return typeof record.run === 'function' ? ['run'] : []
}

/** Async public entries can acquire admission before calling their implementation. */
export function isAsyncProcessEntry(entry: unknown): boolean {
  return typeof entry === 'function' && entry.constructor.name === 'AsyncFunction'
}
