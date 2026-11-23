/**
 * `remote_bash` as a tool definition. The optional broker-attested remote
 * tools row registers it (see `remote/tools.ts`); test compositions register
 * it directly. The tool can only run where the remote control plane is ready
 * anyway.
 * Remote stdout/stderr is data, never a local path reference.
 *
 * The execute boundary validates the advertised schema itself (upstream tools
 * validate their own arguments) so a structural mistake is an
 * `invalid-arguments` result before any Registry admission or SSH I/O. The
 * session and tool name used by admission come from dispatch context only.
 */
import type { MultiRootRegistry } from '../registry.ts'
import type { ToolCaller } from '../compat/tool-context.ts'
import { runRemoteCommand, type RemoteCommandResult, type RemoteExecutionBackend } from './exec.ts'
import { isRecord, parseRemoteBashArguments, REMOTE_BASH_PARAMETERS, safeLabelPart, type ArgumentIssue } from './tool-arguments.ts'
import { argumentFailureGuidance } from './result-guidance.ts'
import { DEFAULT_OUTPUT_PREVIEW_BYTES } from './output-budget.ts'

const NAME = 'remote_bash'

const DESCRIPTION = [
  'Run one command on a registered remote environment root.',
  'environmentId must name a remote environment explicitly (never "local"); rootId is its registered binding root, cwdRelative is relative to that root ("" or omitted means the root itself).',
  `stdout and stderr are data, never local path references. Each stream previews at most ${DEFAULT_OUTPUT_PREVIEW_BYTES / 1024} KiB by default; maxOutputBytes raises or lowers that per-stream cap, never above the deployment limit.`,
  'The result reports truncated per stream together with totalBytes (raw bytes observed) and droppedBytes (raw bytes outside the preview); both are null when the backend cannot prove the exact total. On unknown, check the remote state with reconcileId before retrying; on admitted-may-start, confirm whether the command actually started before retrying.',
].join(' ')

/** The zero-I/O refusal for structurally invalid arguments. */
function invalidArguments(args: unknown, issues: readonly ArgumentIssue[]): RemoteCommandResult {
  const record = isRecord(args) ? args : {}
  const text = argumentFailureGuidance('remote_bash', issues)
  return {
    environmentId: typeof record.environmentId === 'string' ? safeLabelPart(record.environmentId, 128) : '',
    rootId: typeof record.rootId === 'string' ? safeLabelPart(record.rootId, 256) : '',
    status: 'not-started',
    code: 'invalid-arguments',
    message: text.message,
    hint: text.hint,
  }
}

/** Build the `remote_bash` tool registration for `ctx.tools.register`. */
export function remoteBashTool(options: {
  registry: MultiRootRegistry
  backendFor: (environmentId: string, workspace: string, environmentDigest?: string) => RemoteExecutionBackend | undefined
}) {
  return {
    name: NAME,
    description: DESCRIPTION,
    parameters: REMOTE_BASH_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, result: RemoteCommandResult) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    execute: async (args: unknown, exec: ToolCaller): Promise<RemoteCommandResult> => {
      const parsed = parseRemoteBashArguments(args)
      if (!parsed.ok) return invalidArguments(args, parsed.issues)
      if (parsed.value.environmentId === 'local') {
        return invalidArguments(args, [{ path: 'environmentId', detail: 'must name a remote environment; "local" is not remote' }])
      }
      const { environmentId, rootId, cwdRelative, command, timeoutMs, maxOutputBytes } = parsed.value
      return await runRemoteCommand(options.registry, options.backendFor, {
        session: exec.agent?.session as never,
        environmentId,
        rootId,
        cwdRelative,
        command,
        timeoutMs,
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      }, exec.name, exec.signal!)
    },
  }
}
