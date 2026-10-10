/** The around-dispatch seam is optional on older hosts; do not import their tool runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface ToolCaller {
  readonly agent?: Agent
  readonly callId: string
  readonly name: string
}

export function aroundTool(ctx: Context, listener: (exec: ToolCaller, next: () => Promise<unknown>) => Promise<unknown>): void {
  // Stable subset of the public waterfall. Older releases have no event type
  // declaration, and no dispatch of it; registration there is inert.
  const on = ctx.on as unknown as (name: string, callback: typeof listener) => unknown
  on.call(ctx, 'tools/execute', listener)
}
