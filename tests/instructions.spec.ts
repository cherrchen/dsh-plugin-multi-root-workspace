/**
 * Additional-root instruction injection.
 *
 * The provider's whole job is to make an additional root's own `AGENTS.md`
 * visible to a model that is already allowed to write that root, WITHOUT
 * duplicating anything upstream already supplies. So the cases below are as
 * much about what is NOT injected as about what is: the user-global file, the
 * primary root's chain, and any ancestor of an additional root all stay
 * upstream's business, and an empty scope must produce no message at all — that
 * is what keeps the passthrough invariant intact.
 *
 * The provider is exercised through the real `agent/pre-step` waterfall with a
 * minimal agent stand-in, because `agent.session` is all it reads: everything
 * else it needs comes from `ctx.sandboxPolicy`, `ctx.multiRootScope` and
 * `ctx.fs`, which are the real services here.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootFileSystem } from '../src/fs.ts'
import * as Instructions from '../src/instructions.ts'
import { PLUGIN_SOURCE } from '../src/instructions.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let repoA: string
let repoB: string
let dshHome: string
let previousDshHome: string | undefined
let counter = 0
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('instructions')
  repoA = join(fixture.base, 'repo-a')
  repoB = join(fixture.base, 'repo-b')
  dshHome = join(fixture.base, 'home')
  for (const directory of [repoA, repoB, dshHome]) mkdirSync(directory, { recursive: true })
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  fixture.dispose()
})

/** One mounted composition plus the handle a spec drives it with. */
interface World {
  readonly ctx: Context
  /** Run one `agent/pre-step` and return the message this row injected, if any. */
  step: (claimed?: readonly UserMessage[]) => Promise<UserMessage | undefined>
  /** Run one `agent/pre-step` and return the whole decision. */
  decide: (claimed?: readonly UserMessage[]) => Promise<PreStepDecision>
  /** Replace the registered additional roots. */
  roots: (paths: readonly string[]) => void
}

/**
 * Mount the row over the real fs fence, scope service and policy service.
 * @param config - the row's configuration.
 * @param roots - additional roots to register up front.
 * @returns the world.
 */
async function mountWorld(config: Instructions.Config = {}, roots: readonly string[] = []): Promise<World> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
    await ctx.plugin(MultiRootScopeService),
  )
  await mountCompat(ctx)
  fibers.push(
    await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }),
    await ctx.plugin(Instructions, config),
  )

  // A real Session, because `ctx.sandboxPolicy.resolve({ session })` reads the
  // session projection, not just the header.
  const sessionId = SessionId(`sess-instructions-${counter += 1}`)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    cwd: fixture.workspace,
  })
  const agent = { session } as unknown as Agent
  const setRoots = (paths: readonly string[]): void => {
    ctx.multiRootScope.setAdditionalRoots(
      fixture.workspace,
      paths.map((path, index) => ({ id: `root-${index}`, path, recordedPath: canonicalPath(path) })),
    )
  }
  setRoots(roots)

  const decide = async (claimed: readonly UserMessage[] = []): Promise<PreStepDecision> => {
    const messages = [...claimed]
    return await ctx.waterfall(
      'agent/pre-step',
      { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [...messages] }),
    )
  }

  return {
    ctx,
    decide,
    roots: setRoots,
    step: async (claimed: readonly UserMessage[] = []) => {
      const decision = await decide(claimed)
      if (decision.kind !== 'enter') return undefined
      return decision.messages.find(message => message.source.kind === 'plugin')
    },
  }
}

/** A message standing in for one the loop claimed from the inbox. */
function claimedMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The text of one message, concatenated. */
function textOf(message: UserMessage | undefined): string {
  return (message?.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('with no additional root', () => {
  it('injects nothing at all, so the composition stays a passthrough', async () => {
    writeFileSync(join(fixture.workspace, 'AGENTS.md'), '# primary rules')
    const world = await mountWorld()
    const claimed = claimedMessage('do the thing')
    const decision = await world.decide([claimed])
    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages).toEqual([claimed])
  })
})

describe('with additional roots', () => {
  it('injects each root\'s own top-level instruction file', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    writeFileSync(join(repoB, 'CLAUDE.md'), '# repo-b rules')
    const world = await mountWorld({}, [repoA, repoB])

    const text = textOf(await world.step())
    expect(text).toContain('# repo-a rules')
    expect(text).toContain('# repo-b rules')
  })

  it('names each file by its absolute path, so two roots\' AGENTS.md are distinguishable', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    writeFileSync(join(repoB, 'AGENTS.md'), '# repo-b rules')
    const world = await mountWorld({}, [repoA, repoB])

    const text = textOf(await world.step())
    expect(text).toContain(join(repoA, 'AGENTS.md'))
    expect(text).toContain(join(repoB, 'AGENTS.md'))
  })

  it('tags the message as plugin-produced instruction context, in the user role', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    const message = await world.step()
    expect(message?.role).toBe('user')
    expect(message?.source).toMatchObject({ kind: 'plugin', plugin: PLUGIN_SOURCE, form: 'instructions' })
  })

  it('lands right after the last claimed message, where upstream puts its own baseline', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    const claimed = claimedMessage('do the thing')
    const decision = await world.decide([claimed])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]).toBe(claimed)
    expect(decision.messages[1]?.source.kind).toBe('plugin')
  })

  it('preserves scope order across roots', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    writeFileSync(join(repoB, 'AGENTS.md'), '# repo-b rules')
    const world = await mountWorld({}, [repoB, repoA])

    const text = textOf(await world.step())
    expect(text.indexOf('# repo-b rules')).toBeLessThan(text.indexOf('# repo-a rules'))
  })

  it('says nothing about a root that carries no instruction file', async () => {
    const world = await mountWorld({}, [repoA])
    expect(await world.step()).toBeUndefined()
  })
})

describe('what it refuses to duplicate', () => {
  it('never injects the user-global instruction file', async () => {
    writeFileSync(join(dshHome, 'AGENTS.md'), '# user-global rules')
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    const text = textOf(await world.step())
    expect(text).toContain('# repo-a rules')
    expect(text).not.toContain('# user-global rules')
  })

  it('never injects the primary root\'s instruction file', async () => {
    writeFileSync(join(fixture.workspace, 'AGENTS.md'), '# primary rules')
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    const text = textOf(await world.step())
    expect(text).toContain('# repo-a rules')
    expect(text).not.toContain('# primary rules')
  })

  it('never injects an ancestor of an additional root', async () => {
    writeFileSync(join(fixture.base, 'AGENTS.md'), '# ancestor rules')
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    const text = textOf(await world.step())
    expect(text).toContain('# repo-a rules')
    expect(text).not.toContain('# ancestor rules')
  })

  it('ignores a file larger than the source cap', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), 'x'.repeat(2048))
    const world = await mountWorld({ maxSourceBytes: 512 }, [repoA])
    expect(await world.step()).toBeUndefined()
  })
})

describe('across steps', () => {
  it('does not re-send instructions the model already has', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])

    expect(textOf(await world.step())).toContain('# repo-a rules')
    expect(await world.step()).toBeUndefined()
    expect(await world.step()).toBeUndefined()
  })

  it('re-sends when the file\'s content changed', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])
    expect(textOf(await world.step())).toContain('# repo-a rules')

    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a revised rules')
    expect(textOf(await world.step())).toContain('# repo-a revised rules')
  })

  it('sends only the root that changed, not every root again', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    writeFileSync(join(repoB, 'AGENTS.md'), '# repo-b rules')
    const world = await mountWorld({}, [repoA, repoB])
    await world.step()

    writeFileSync(join(repoB, 'AGENTS.md'), '# repo-b revised rules')
    const text = textOf(await world.step())
    expect(text).toContain('# repo-b revised rules')
    expect(text).not.toContain('# repo-a rules')
  })
})

describe('when a root leaves the workspace', () => {
  it('revokes its instructions explicitly instead of falling silent', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])
    await world.step()

    world.roots([])
    const text = textOf(await world.step())
    expect(text).toContain(canonicalPath(repoA))
    expect(text).toContain('no longer')
  })

  it('revokes a root the scope withheld, not only one the operator removed', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])
    await world.step()

    // A registration whose recorded directory no longer matches is withheld by
    // the scope itself (the `redirected` case), which is the same signal as a
    // removal from this row's point of view.
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{
      id: 'root-0',
      path: repoA,
      recordedPath: join(fixture.base, 'somewhere-else'),
    }])
    expect(textOf(await world.step())).toContain('no longer')
  })

  it('revokes once, then stays quiet', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])
    await world.step()
    world.roots([])
    expect(await world.step()).toBeDefined()
    expect(await world.step()).toBeUndefined()
  })

  it('re-sends the instructions when the root comes back', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({}, [repoA])
    await world.step()
    world.roots([])
    await world.step()

    world.roots([repoA])
    expect(textOf(await world.step())).toContain('# repo-a rules')
  })
})

describe('the byte budget', () => {
  it('is shared across every additional root rather than granted per root', async () => {
    const chunk = '# rules '.repeat(200)
    writeFileSync(join(repoA, 'AGENTS.md'), chunk)
    writeFileSync(join(repoB, 'AGENTS.md'), chunk)
    const maxBytes = 900
    const world = await mountWorld({ maxBytes }, [repoA, repoB])

    const text = textOf(await world.step())
    const rendered = text.length - (Instructions.composeInstructionMessage([], [])?.length ?? 0)
    expect(rendered).toBeGreaterThan(0)
    // The framing sentence is this row's own; the rendered instruction payload
    // is what the budget bounds, and two roots must not each get `maxBytes`.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(maxBytes * 2)
  })

  it('is disabled entirely by a non-positive budget', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# repo-a rules')
    const world = await mountWorld({ maxBytes: 0 }, [repoA])
    expect(await world.step()).toBeUndefined()
  })
})

describe('composeInstructionMessage', () => {
  it('says nothing when there is nothing to add or retract', () => {
    expect(Instructions.composeInstructionMessage([], [])).toBeUndefined()
  })

  it('states that the roots are part of this workspace', () => {
    const text = Instructions.composeInstructionMessage([{ root: '/r', text: 'rules', digest: 'd' }], [])
    expect(text).toContain('additional roots')
    expect(text).toContain('/r')
    expect(text).toContain('rules')
  })

  it('carries additions and retractions in one message', () => {
    const text = Instructions.composeInstructionMessage([{ root: '/a', text: 'rules', digest: 'd' }], ['/b'])
    expect(text).toContain('/a')
    expect(text).toContain('/b')
    expect(text).toContain('no longer')
  })
})
