/**
 * `remote_bash` as a tool definition. The optional broker-attested remote
 * tools row registers it (see `remote/tools.ts`); test compositions register
 * it directly. The tool can only run where the remote control plane is ready
 * anyway.
 * Remote stdout/stderr is data, never a local path reference.
 */
import type { MultiRootRegistry } from '../registry.ts'
import type { ToolCaller } from '../compat/tool-context.ts'
import { runRemoteCommand, type RemoteCommandResult, type RemoteExecutionBackend } from './exec.ts'

const NAME = 'remote_bash'

/** Build the `remote_bash` tool registration for `ctx.tools.register`. */
export function remoteBashTool(options: {
  registry: MultiRootRegistry
  backendFor: (environmentId: string) => RemoteExecutionBackend | undefined
}) {
  return {
    name: NAME,
    description: 'Run one command on a registered remote environment root.',
    parameters: {
      type: 'object',
      properties: {
        environmentId: { type: 'string' },
        rootId: { type: 'string' },
        cwdRelative: { type: 'string', default: '' },
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['environmentId', 'rootId', 'command', 'timeoutMs'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, result: RemoteCommandResult) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    execute: async (args: unknown, exec: ToolCaller): Promise<RemoteCommandResult> => {
      const { environmentId, rootId, cwdRelative, command, timeoutMs } = args as {
        environmentId: string; rootId: string; cwdRelative?: string; command: string; timeoutMs: number
      }
      return await runRemoteCommand(options.registry, options.backendFor, {
        session: exec.agent?.session as never, environmentId, rootId, cwdRelative, command, timeoutMs,
      }, exec.name, exec.signal!)
    },
  }
}
