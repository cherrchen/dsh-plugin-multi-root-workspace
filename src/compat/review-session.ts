/** Fingerprint only the native instruction producer's visible authority data. */
import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
export function nativeInstructionFingerprint(session: Session): string {
  const rows: unknown[] = []
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- Review needs source metadata; no instruction projection is public.
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === 'agent-instructions') rows.push(event.data)
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
