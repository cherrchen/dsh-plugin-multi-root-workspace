/**
 * The real remote execution backend: adapts one open `SshEnvironment` to the
 * `RemoteExecutionBackend` contract G3 verified. Confinement is the upstream
 * sandbox's, spawning is the upstream runtime's; this adapter maps loss to
 * `RemoteConnectionLost`, never re-spawns, and reports the manager's live
 * generation so a stale connection can never pass the B-admission check.
 */
import type { RemoteEnvironment } from './manifest.ts'
import { RemoteConnectionLost, type RemoteExecutionBackend, type RemoteExecDeployment, type RemoteProcessHandle } from './exec.ts'
import type { SshEnvironment, SshEnvironmentManager } from './ssh-environment.ts'

/** The deployment block the manifest's `exec` stanza becomes. */
function deploymentOf(environment: RemoteEnvironment): RemoteExecDeployment | undefined {
  if (environment.exec === undefined) return undefined
  const { shell, env, maxTimeoutMs, stdoutLimit, stderrLimit, terminateGraceMs } = environment.exec
  return { shell, env, maxTimeoutMs, stdoutLimit, stderrLimit, terminateGraceMs }
}

/** Build the backend for one environment, or `undefined` when it has no exec. */
export function sshExecBackend(
  environment: RemoteEnvironment, env: SshEnvironment, manager: SshEnvironmentManager,
): RemoteExecutionBackend | undefined {
  const deployment = deploymentOf(environment)
  if (deployment === undefined) return undefined
  interface Collected { readFrom(offset: number): { text: string } | undefined }
  interface Handle {
    done: Promise<Record<string, unknown>>
    waitForExit(signal?: AbortSignal): Promise<boolean>
    terminate(): void
    collected?: { stdout?: Collected; stderr?: Collected }
  }
  const lost = (error: unknown): RemoteConnectionLost => {
    manager.markStale(environment.environmentId)
    return error instanceof RemoteConnectionLost ? error : new RemoteConnectionLost(error instanceof Error ? error.message : String(error))
  }
  return {
    deployment,
    async confine(argv, policy, signal) {
      try {
        const confined = await env.sandbox.confine(argv, policy, signal)
        return { argv: confined.argv, enforcement: confined.enforcement as 'full' | 'partial', generation: env.generation }
      } catch (error) { throw lost(error) }
    },
    currentGeneration() { return manager.generationOf(environment.environmentId) },
    spawn(argv, options, sink) {
      let handle: Handle
      try {
        handle = env.subprocess.spawn({
          argv, cwd: options.cwd, env: options.env,
          // The collector keeps 2× the declared limit so overflow reaches the
          // sink and the reported `truncated` flag reflects the contract bound.
          stdio: { stdin: 'ignore', stdout: { maxBytes: deployment.stdoutLimit * 2 }, stderr: { maxBytes: deployment.stderrLimit * 2 } },
          graceMs: deployment.terminateGraceMs,
        }) as Handle
      } catch (error) { throw lost(error) }
      const feed = () => {
        for (const [name, stream] of [['stdout', handle.collected?.stdout], ['stderr', handle.collected?.stderr]] as const) {
          if (stream === undefined) continue
          const bytes = stream.readFrom(0)
          if (bytes !== undefined) sink[name](new TextEncoder().encode(bytes.text))
        }
      }
      return {
        // The upstream spec has no separate start acknowledgement: spawn
        // returns a handle whose done is already tracked, so started is now.
        started: Promise.resolve(),
        exited: (async () => {
          try {
            const done = await handle.done
            feed()
            return { exitCode: (done.exitCode ?? null) as number | null, signal: (done.signal ?? null) as string | null }
          } catch (error) { feed(); throw lost(error) }
        })() as Promise<{ exitCode: number | null; signal: string | null }>,
        terminate: () => handle.terminate(),
        waitForExit: async (timeoutMs: number) => await Promise.race([
          handle.waitForExit(AbortSignal.timeout(timeoutMs)).catch(() => false),
          new Promise<boolean>(resolve => { setTimeout(() => resolve(false), timeoutMs + 50).unref() }),
        ]),
      } satisfies RemoteProcessHandle
    },
  }
}
