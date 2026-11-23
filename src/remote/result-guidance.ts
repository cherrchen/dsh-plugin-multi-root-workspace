/**
 * Bounded, actionable copy for remote tool failures. The text is generated
 * from STABLE error codes and safe fields only — never from a caught
 * exception message, an SSH diagnostic, or a credential path — so a failure
 * can reach model context without leaking host detail.
 *
 * A message names what happened; a hint names the next corrective step.
 * Endpoint candidates are hints for fixing the call; every retry still goes
 * through formal Registry admission.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-result-guidance
 */
import { safeLabelPart, type ArgumentIssue } from './tool-arguments.ts'

/** The bounded copy attached to one diagnostic tool result. */
export interface Guidance {
  /** One sentence naming what happened. */
  readonly message: string
  /** One to three sentences naming the next step. */
  readonly hint: string
}

/** Copy-result fields the guidance may safely use. */
export interface CopyGuidanceContext {
  readonly from: string
  readonly to: string
  readonly fromRootId: string
  readonly toRootId: string
  readonly fromRelativePath: string
  readonly toRelativePath: string
  /** The admitted display path of each remote endpoint, once admission ran. */
  sourceDisplayPath?: string
  destinationDisplayPath?: string
  /** Registered `environmentId:rootId` candidates for each direction. */
  sourceCandidates?: readonly string[]
  destinationCandidates?: readonly string[]
  /** Local root ids usable as a copy endpoint (`primary` plus aliasIds). */
  localRootIds?: readonly string[]
}

/** Exec-result fields the guidance may safely use. */
export interface ExecGuidanceContext {
  readonly environmentId: string
  readonly rootId: string
  /** The admitted display path of the granted remote root. */
  displayPath?: string
  /** The requested relative working directory (`""` means the root). */
  cwdRelative?: string
  /** The deployment's accepted timeout range. */
  maxTimeoutMs?: number
  /** Registered `environmentId:rootId` candidates that allow execution. */
  candidates?: readonly string[]
}

const MESSAGE_LIMIT = 240
const HINT_LIMIT = 560
const CANDIDATE_LIMIT = 6
const ISSUE_LIMIT = 4

/**
 * Bound one generated sentence pair to what a model result should carry.
 * @param text - the generated text.
 * @param limit - maximum retained characters.
 * @returns the text, truncated with an ASCII ellipsis when needed.
 */
export function boundText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`
}

function guidance(message: string, hint: string): Guidance {
  return { message: boundText(message, MESSAGE_LIMIT), hint: boundText(hint, HINT_LIMIT) }
}

/**
 * Render structural argument issues for the `invalid-arguments` result.
 * @param toolName - the dispatching tool name.
 * @param issues - located issues from the shared validator.
 * @returns the bounded message and a fix-it hint.
 */
export function argumentFailureGuidance(toolName: 'remote_copy' | 'remote_bash', issues: readonly ArgumentIssue[]): Guidance {
  const shown = issues.slice(0, ISSUE_LIMIT).map(issue => issue.path === ''
    ? `arguments ${issue.detail}`
    : `"${safeLabelPart(issue.path, 96)}" ${issue.detail}`)
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : ''
  const hint = toolName === 'remote_copy'
    ? 'Fix the named fields and call remote_copy again. Omitted environmentId means local; a remote endpoint must set environmentId explicitly, and both sides take the same fields.'
    : 'Fix the named fields and call remote_bash again. environmentId must name a registered remote environment; command, rootId and an integer timeoutMs are required.'
  return guidance(`Invalid ${toolName} arguments: ${shown.join('; ')}${more}.`, hint)
}

function candidateHint(noun: string, candidates: readonly string[] | undefined): string | undefined {
  if (candidates === undefined) return undefined
  if (candidates.length === 0) return `No registered endpoint currently satisfies the ${noun} for this workspace.`
  const shown = candidates.slice(0, CANDIDATE_LIMIT)
  const more = candidates.length > shown.length ? ` (+${candidates.length - shown.length} more)` : ''
  return `Registered endpoints for the ${noun}: ${shown.join(', ')}${more}.`
}

function endpointHints(
  context: { readonly sourceCandidates?: readonly string[]; readonly destinationCandidates?: readonly string[] },
): string {
  const parts = [
    candidateHint('source direction', context.sourceCandidates),
    candidateHint('destination direction', context.destinationCandidates),
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(' ') : 'Check the environmentId:rootId pair against the workspace topology; a usable endpoint must also be registered and allow the action this direction needs.'
}

function localRootHint(context: CopyGuidanceContext): string {
  const ids = context.localRootIds === undefined || context.localRootIds.length === 0
    ? 'primary'
    : boundText(context.localRootIds.slice(0, CANDIDATE_LIMIT).join(', '), 240)
  return `Local endpoints are "primary" for the session workspace root or a registered additional root's aliasId; registered now: ${ids}.`
}

const UNCERTAIN = 'The outcome is unknown: the target may or may not have been published. Check the destination and any staging entry before retrying; do not retry blindly.'

/**
 * Guidance for one `remote_copy` result. Committed results never call this.
 * @param code - the result's stable code; may be absent on non-failed results.
 * @param status - the result status.
 * @param context - safe endpoint facts.
 * @returns the bounded message and hint.
 */
export function copyFailureGuidance(
  code: string | undefined,
  status: 'failed' | 'cancelled' | 'partial' | 'unknown',
  context: CopyGuidanceContext,
): Guidance {
  if (status === 'unknown') return guidance('The copy outcome is unknown.', `${UNCERTAIN} The result carries a reconcileId.`)
  if (status === 'cancelled') return guidance('The copy was cancelled before it finished.', 'No target was published by this call. Retry only if the copy is still needed.')
  if (status === 'partial') return guidance('The copy completed only partially.', `${UNCERTAIN} Check the result's staging field for what this operation left behind.`)
  switch (code) {
    case 'invalid-arguments':
      return guidance('The remote_copy arguments are structurally invalid.', 'Fix the named field and call again; both endpoints take the same fields, and a remote endpoint must set environmentId explicitly.')
    case 'direction-unsupported':
      return guidance('Both endpoints are local; remote_copy needs at least one remote endpoint.', 'Set environmentId to a registered remote environment on the side that should move the file.')
    case 'session-unavailable':
      return guidance('The call reached no live session, so no remote admission could run.', 'Call the tool from an active workspace session.')
    case 'cancelled':
      return guidance('The copy was cancelled before it finished.', 'No target was published by this call. Retry only if the copy is still needed.')
    case 'transfer-timeout':
      return guidance('The copy exceeded the transfer time budget.', 'No target is published. Retry only if the remaining budget is enough; prefer copying a smaller file.')
    case 'transfer-too-large':
      return guidance('The source exceeds the maximum transferable file size.', 'The deployment caps one file at the transfer budget; copy a smaller file.')
    case 'unknown-environment':
      return guidance('environmentId does not name a deployed remote environment.', 'Use an environmentId from the workspace topology.')
    case 'transfer-unavailable':
      return guidance('An endpoint does not declare file-transfer capability.', 'Ask the operator to enable transfer for this environment and binding.')
    case 'remote-unavailable':
      return guidance('The remote control plane is not ready.', 'Check the remote status in the workspace panel, then retry when it is ready.')
    case 'config-digest-mismatch':
      return guidance('The remote deployment manifest changed during this call.', 'Refresh the workspace view so the new manifest is loaded, then retry.')
    case 'owner-without-remote-protocol':
      return guidance('The Host that owns the registry does not expose the remote protocol.', 'Restart the Host with a profile that mounts the remote tools, then retry.')
    case 'authority-unavailable':
    case 'authority-disconnected':
    case 'authority-busy':
    case 'authority-timeout':
      return guidance('The shared registry authority is temporarily unavailable.', 'Wait for the registry authority to recover, then retry; every retry is admitted again.')
    case 'session-policy-unavailable':
      return guidance('No live sandbox policy could be resolved for the session.', 'Start a new session in this workspace and retry.')
    case 'stale-epoch':
      return guidance('The remote admission belongs to an older control-plane epoch.', 'Refresh the workspace state and retry; the new epoch is admitted separately.')
    case 'mode-denies':
      return guidance('The session is read-only, so it cannot copy to a remote root.', 'Run the copy in a workspace-write session.')
    case 'tool-capped':
      return guidance('This tool is capped to read-only for the current session.', 'Use an uncapped tool or a workspace-write session.')
    case 'endpoint-not-registered':
      return guidance('A remote endpoint of this copy is not registered in this workspace.', endpointHints(context))
    case 'endpoint-withheld':
      return guidance('A remote endpoint was withheld pending re-registration.', `Re-register the directory from Workspace Folders, then retry. ${endpointHints(context)}`)
    case 'endpoint-revoked':
      return guidance('A remote endpoint was revoked from this workspace.', `Register the directory again before copying to it. ${endpointHints(context)}`)
    case 'action-not-allowed':
      return guidance('A binding does not allow the action this copy direction needs.', `The source needs "read" and the destination needs "write". ${endpointHints(context)}`)
    case 'transfer-pair-not-allowed':
      return guidance('The source binding does not pair with the destination for transfers.', `The source must export to the destination root and the destination must import from the source root. ${endpointHints(context)}`)
    case 'local-root-unavailable':
      return guidance('A local endpoint does not name an available registered root.', localRootHint(context))
    case 'local-authority-unavailable':
      return guidance('A follower Host cannot read this local endpoint without an owner-admitted record.', 'Retry from the Host that owns the registry authority.')
    case 'admission-changed':
      return guidance("The remote authority changed between this copy's admission and its publication.", 'Nothing was published by this call. Review the workspace state, then retry.')
    case 'invalid-relative-path':
      return guidance('relativePath is not a normalized relative path to one file.', 'Use a relative path with no leading "/", no "." or ".." segment and no empty segments.')
    case 'local-platform-unsupported':
      return guidance('Local file transfer requires a POSIX Host.', 'Run the Host on Linux or macOS.')
    case 'local-root-redirected':
      return guidance('The granted local root no longer resolves to the registered directory.', 'Inspect the workspace root state; a replaced or redirected root needs re-registration.')
    case 'protected-path':
      return guidance('The local destination lies inside a protected DSH directory.', 'Choose a destination inside a granted workspace root.')
    case 'reserved-name':
      return guidance('The destination name uses the remote staging namespace.', 'Choose a relativePath that does not start with ".dsh-staging-".')
    case 'source-not-regular':
      return guidance('The source is not a regular file.', 'remote_copy copies one regular file; directories and special files are not supported.')
    case 'source-multilinked':
      return guidance('The local source has more than one hard link.', 'Copy from a file with a single link, or copy the content elsewhere first.')
    case 'source-escapes-root':
      return guidance('The source resolves outside its granted root.', 'Use a relativePath that stays inside the root; symlinks and replaced directories are refused.')
    case 'source-symlinked':
      return guidance('The source path crosses a symlink.', 'Use the real path inside the granted root.')
    case 'source-too-large':
      return guidance('The source exceeds the transfer budget.', 'Copy a smaller file.')
    case 'source-changed':
      return guidance('The source changed while the copy was running.', 'No target was published. Retry when the source is stable.')
    case 'source-unreadable':
    case 'source-open-failed':
      return guidance('The source file could not be opened for reading.', `Check the relativePath under the source root and its permissions. ${context.from}`)
    case 'source-connection-lost':
      return guidance('The source connection was lost during the copy.', 'No target is assumed published and this operation cleaned up its staging. Verify the source and destination state before retrying.')
    case 'target-exists':
      return guidance('The destination file already exists; remote_copy never overwrites.', 'Choose another relativePath or remove the existing file explicitly.')
    case 'target-escapes-root':
    case 'destination-escapes-root':
      return guidance('The destination parent is outside the granted root.', 'Use a relativePath whose parent stays inside the destination root.')
    case 'destination-parent-missing': {
      const root = context.destinationDisplayPath === undefined ? 'the destination root' : safeLabelPart(context.destinationDisplayPath, 160)
      const relative = safeLabelPart(context.toRelativePath, 96)
      const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
      const target = parent === '' ? root : `${root.replace(/\/+$/, '')}/${parent}`
      return guidance(`The destination parent directory ${target} does not exist.`, 'Create that directory under the destination root, or use a relativePath whose parent already exists.')
    }
    case 'destination-parent-not-directory':
      return guidance('A component of the destination parent is not a directory.', 'Choose a destination whose parent chain is made of real directories.')
    case 'destination-symlinked':
      return guidance('The destination path crosses a symlink.', 'Use the real directory inside the granted root.')
    case 'destination-changed':
      return guidance('The destination parent changed during the copy.', 'No target is assumed published; verify the destination state before retrying.')
    case 'destination-connection-lost':
      return guidance('The destination connection was lost during the copy.', `${UNCERTAIN} The result carries a reconcileId.`)
    case 'publish-failed':
      return guidance('The final no-replace publication failed.', 'Check the destination for an existing file or a residual staging entry before retrying.')
    case 'publish-unverified':
      return guidance('The publication succeeded but could not be confirmed.', `${UNCERTAIN} The result reports its staging state and a reconcileId.`)
    case 'staging-changed':
      return guidance('The remote staging object changed during verification.', 'No target was published. Retry once the destination state is stable.')
    case 'staging-closed':
      return guidance('The staging handle closed before the copy finished.', 'Retry; the previous staging was cleaned up by this operation.')
    case 'staging-unavailable':
      return guidance('The destination could not create a staging object.', 'Check the destination root permissions and available space.')
    case 'staging-write-failed':
      return guidance('Writing the staging object failed.', 'Check the destination root permissions and free space.')
    case 'staging-full':
      return guidance('The destination filesystem has no space for the staging object.', 'Free space on the destination, then retry.')
    case 'staging-unverified':
      return guidance('The staged bytes could not be verified exactly.', 'No target was published. Retry once.')
    case 'verify-mismatch':
      return guidance('The staged bytes did not match the source digest.', 'No target was published. Retry; if it persists, check the destination host.')
    case 'connection-lost':
      return guidance('The connection was lost during the copy.', `${UNCERTAIN} The result carries a reconcileId.`)
    default:
      return guidance(
        code === undefined ? 'The copy failed.' : `The copy failed with code "${boundText(code, 64)}".`,
        'Check the workspace topology, binding actions and both relative paths, then retry.',
      )
  }
}

const EXEC_UNCERTAIN = 'The command may have started. Confirm on the remote host whether it is still running before starting another; do not retry blindly.'

/**
 * Guidance for one `remote_bash` `not-started` result.
 * @param code - the stable refusal code.
 * @param context - safe endpoint facts, when admission reached them.
 * @returns the bounded message and hint.
 */
export function execFailureGuidance(code: string, context: ExecGuidanceContext): Guidance {
  switch (code) {
    case 'invalid-arguments':
      return guidance('The remote_bash arguments are structurally invalid.', 'Fix the named fields and call again; environmentId must name a registered remote environment.')
    case 'invalid-cwd': {
      const root = context.displayPath === undefined ? 'the granted root' : `the granted root (${context.displayPath})`
      return guidance('cwdRelative is not a normalized relative path.', `cwdRelative "" runs in ${root}; otherwise pass a normalized relative POSIX path such as "src/app" with no leading "/", "." or ".." segments.`)
    }
    case 'invalid-timeout':
      return guidance(
        "timeoutMs is outside the environment's allowed range.",
        context.maxTimeoutMs === undefined ? 'Use a positive integer within the environment limit.' : `Use an integer from 1 to ${context.maxTimeoutMs}.`,
      )
    case 'cancelled':
      return guidance('The command was cancelled before completion.', 'Confirm the remote process state before starting another command.')
    case 'backend-unavailable':
      return guidance('This environment has no execution backend bound for the session.', 'Check that the connection allows command execution and is currently connected.')
    case 'confine-failed':
      return guidance('The remote sandbox could not confine the command.', 'Check the Helper installation and sandbox support on the remote host, then retry.')
    case 'sandbox-unverified':
      return guidance('The remote sandbox reported partial confinement, so the command was refused.', 'Reinstall or repair the Helper, then retry.')
    case 'admission-changed':
      return guidance('The remote authority changed between the two admissions.', 'The command did not start. Review the workspace state, then retry.')
    case 'endpoint-not-registered':
      return guidance('The remote endpoint is not registered in this workspace.', candidateHint('exec action', context.candidates) ?? 'Check the environmentId:rootId pair against the workspace topology.')
    case 'endpoint-withheld':
      return guidance('The remote endpoint was withheld pending re-registration.', `Re-register the directory from Workspace Folders, then retry. ${candidateHint('exec action', context.candidates) ?? ''}`)
    case 'endpoint-revoked':
      return guidance('The remote endpoint was revoked from this workspace.', `Register the directory again before running commands. ${candidateHint('exec action', context.candidates) ?? ''}`)
    case 'action-not-allowed':
      return guidance('The binding does not allow "exec" for this endpoint.', `Ask the operator to grant execution on this remote root. ${candidateHint('exec action', context.candidates) ?? ''}`)
    case 'binding-not-authorized':
      return guidance('No deployment binding authorizes this endpoint for the workspace root.', candidateHint('exec action', context.candidates) ?? 'Check the environmentId:rootId pair against the workspace topology.')
    case 'platform-mismatch':
      return guidance('The endpoint platform does not match the manifest.', 'Re-register the endpoint after fixing the connection.')
    case 'mode-denies':
      return guidance('The session is read-only, so it cannot run remote commands.', 'Run the command in a workspace-write session.')
    case 'tool-capped':
      return guidance('This tool is capped to read-only for the current session.', 'Use an uncapped tool or a workspace-write session.')
    case 'remote-unavailable':
      return guidance('The remote control plane is not ready.', 'Check the remote status in the workspace panel, then retry when it is ready.')
    case 'config-digest-mismatch':
      return guidance('The remote deployment manifest changed during this call.', 'Refresh the workspace view so the new manifest is loaded, then retry.')
    case 'owner-without-remote-protocol':
      return guidance('The Host that owns the registry does not expose the remote protocol.', 'Restart the Host with a profile that mounts the remote tools, then retry.')
    case 'authority-unavailable':
    case 'authority-disconnected':
    case 'authority-busy':
    case 'authority-timeout':
      return guidance('The shared registry authority is temporarily unavailable.', 'Wait for the registry authority to recover, then retry; every retry is admitted again.')
    case 'session-policy-unavailable':
      return guidance('No live sandbox policy could be resolved for the session.', 'Start a new session in this workspace and retry.')
    case 'stale-epoch':
      return guidance('The remote admission belongs to an older control-plane epoch.', 'Refresh the workspace state and retry; the new epoch is admitted separately.')
    default:
      return guidance(`The command did not start (code "${boundText(code, 64)}").`, 'Check the workspace topology, the endpoint binding actions and timeoutMs, then retry.')
  }
}

/**
 * Guidance for a result that must preserve uncertainty: `unknown` and
 * `admitted-may-start`.
 * @param status - the uncertain status.
 * @returns the bounded message and hint.
 */
export function execUncertainGuidance(status: 'unknown' | 'admitted-may-start'): Guidance {
  return status === 'unknown'
    ? guidance('The command outcome is unknown.', `${EXEC_UNCERTAIN} The result carries a reconcileId.`)
    : guidance('The command may have started, but the launch acknowledgement was not confirmed.', `${EXEC_UNCERTAIN}`)
}

/**
 * Guidance for a command that exited while its process scope stayed
 * unconfirmed: the direct child exited, but descendants may still run.
 * @returns the bounded message and hint.
 */
export function execScopeUnconfirmedGuidance(): Guidance {
  return guidance('The command exited, but its process scope could not be confirmed.', 'Descendants may still be running on the remote host; check before starting work that depends on them.')
}

/**
 * Guidance for a command that ran and was then terminated.
 * @param termination - why the command was terminated.
 * @returns the bounded message and hint.
 */
export function execTerminationGuidance(termination: 'timeout' | 'cancelled' | 'revoked'): Guidance {
  switch (termination) {
    case 'timeout':
      return guidance('The command was terminated because timeoutMs elapsed.', 'Increase timeoutMs for longer work, or run it as a background job outside remote_bash.')
    case 'cancelled':
      return guidance('The command was terminated because the call was cancelled.', 'Confirm the remote process is gone before starting another command.')
    case 'revoked':
      return guidance('The command was terminated because its remote grant changed.', 'Re-register or re-admit the endpoint before starting another command.')
  }
}
