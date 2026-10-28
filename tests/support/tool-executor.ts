/**
 * The 0.2.2 tool-execution split, bridged for the test stacks.
 *
 * From `0.2.2-alpha.2` `dsh-tools` no longer executes: a scoped executor
 * registered through `ctx.tools.setExecutor` owns dispatch
 * (`@deepseek-ai/dsh-tool-executor-native`'s `apply` mounts
 * `ToolExecutionPipeline` + `executeToolBatch` over the public
 * `dsh-tools/pipeline` subpath), and `ctx.tools.execute` takes a batch
 * (`{ calls: ToolCallBlock[] }`) instead of one call. Older releases execute
 * natively and take the single-call shape.
 *
 * Everything here is probed structurally — no version strings, no static
 * imports of the new API — so the same file loads on every matrix release:
 * the pipeline subpath is dynamic-imported only inside the branch that can
 * only run when `setExecutor` exists.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as toolsModule from '@deepseek-ai/dsh-tools'

type BatchTools = {
  setExecutor?: (executor: unknown) => unknown
  execute(input: unknown): Promise<unknown>
}

/** Whether this release routes execution through a mounted executor. */
function isBatchTools(tools: unknown): tools is BatchTools {
  return typeof (tools as BatchTools | undefined)?.setExecutor === 'function'
}

/**
 * Mount the same dispatcher `@deepseek-ai/dsh-tool-executor-native`'s
 * `apply()` contributes — on releases that have executors at all. Older
 * releases execute natively and this call is a no-op.
 * @param ctx - the test world's context.
 */
export async function installToolExecutor(ctx: Context): Promise<void> {
  const tools = (ctx as { tools?: unknown }).tools
  if (!isBatchTools(tools)) return
  // The specifier is built at runtime on purpose: a static `import('.../pipeline')`
  // is resolved by the bundler even behind the probe and fails the whole spec on
  // releases where the subpath does not exist.
  const { ToolExecutionPipeline, executeToolBatch } = await import(`@deepseek-ai/dsh-tools/${'pipeline'}`)
  const projectToolSchema = (toolsModule as Record<string, unknown>).projectToolSchema
  const pipeline = new ToolExecutionPipeline(ctx) as { executionMode(exec: unknown): { kind: string } }
  tools.setExecutor({
    describe: (tools: readonly unknown[]) => ({
      schemas: typeof projectToolSchema === 'function'
        ? tools.map(definition => (projectToolSchema as (d: unknown, flag: boolean) => unknown)(definition, false))
        : [],
    }),
    execute: (input: unknown) => (executeToolBatch as (i: unknown, p: unknown, m: () => number) => Promise<unknown>)(input, pipeline, () => 10),
  })
}

/**
 * Run one tool call through whichever `ctx.tools.execute` shape this release
 * speaks, and unwrap it to the single-call result.
 * @param ctx - the test world's context.
 * @param call - call id, tool name, structured arguments, and the owning agent.
 * @returns the settled tool result.
 */
export async function executeTool(ctx: Context, call: {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}): Promise<unknown> {
  const tools = (ctx as { tools?: unknown }).tools
  if (isBatchTools(tools)) {
    const batch = await tools.execute({
      calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.args) }],
      agent: call.agent,
      signal: call.signal,
    }) as { results: readonly { result: unknown }[] }
    return batch.results[0]!.result
  }
  return await (tools as { execute(input: unknown): Promise<unknown> }).execute({
    callId: call.callId, name: call.name, arguments: call.args, agent: call.agent, signal: call.signal,
  })
}
