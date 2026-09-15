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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { instructionsApi } from '../src/compat/agent-instructions.ts'
import * as LlmMessage from '../src/compat/llm-message.ts'
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
  vi.restoreAllMocks()
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
  decide: (claimed?: readonly UserMessage[], signal?: AbortSignal) => Promise<PreStepDecision>
  /** Replace the registered additional roots. */
  roots: (paths: readonly string[]) => void
  /**
   * Append one tool call and its result, exactly as the loop's session log
   * would, so the row's touch recording sees a real event pair.
   */
  touch: (path: string, options?: { readonly failed?: boolean; readonly tool?: string; readonly session?: Session; readonly callId?: string; readonly deferResult?: boolean }) => (() => void)
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

  const decide = async (claimed: readonly UserMessage[] = [], signal = new AbortController().signal): Promise<PreStepDecision> => {
    const messages = [...claimed]
    return await ctx.waterfall(
      'agent/pre-step',
      { agent, messages, turn: 1, step: 1, signal },
      async () => ({ kind: 'enter', messages: [...messages] }),
    )
  }

  // The one cast in this suite: the row consumes the session log as a cordis
  // event, and these events are hand-built here rather than by `Session.append`.
  //
  // Both carry seq 0 on purpose. They are NOT in the session log, and the
  // mounted projection registry advances its cursor across that log — a seq the
  // log does not contain makes it refuse to advance, while 0 is the value it
  // treats as already reached, so injected events pass through untouched.
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, session: object, event: unknown) => void
  const touch = (path: string, options: { readonly failed?: boolean; readonly tool?: string; readonly session?: Session; readonly callId?: string; readonly deferResult?: boolean } = {}): (() => void) => {
    const callId = options.callId ?? `call-${counter += 1}`
    const name = options.tool ?? 'read'
    emit('session/event', options.session ?? session, {
      type: 'tool/call',
      seq: 0,
      time: 0,
      data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify({ file_path: path }) },
    })
    const result = (): void => { emit('session/event', options.session ?? session, {
      type: 'tool/result',
      seq: 0,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [], isError: options.failed === true }],
        },
      },
    }) }
    if (options.deferResult !== true) result()
    return result
  }

  return {
    ctx,
    decide,
    roots: setRoots,
    touch,
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

describe('nested instructions', () => {
  /** A root with one top-level and one subdirectory instruction file. */
  function seedNested(): void {
    mkdirSync(join(repoB, 'src'), { recursive: true })
    writeFileSync(join(repoB, 'AGENTS.md'), '# repo-b rules')
    writeFileSync(join(repoB, 'src', 'AGENTS.md'), '# repo-b src rules')
    writeFileSync(join(repoB, 'src', 'entry.mjs'), 'export {}\n')
  }

  it('injects a subdirectory\'s file only once a successful call has reached it', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])

    const before = textOf(await world.step())
    expect(before).toContain('# repo-b rules')
    expect(before).not.toContain('# repo-b src rules')

    world.touch(join(repoB, 'src', 'entry.mjs'))
    const after = textOf(await world.step())
    expect(after).toContain('# repo-b src rules')
    expect(after).not.toContain('# repo-b rules')
  })

  it('examines every ancestor of a touched file, so an intermediate directory\'s file reaches the model', async () => {
    seedNested()
    mkdirSync(join(repoB, 'src', 'deep'), { recursive: true })
    writeFileSync(join(repoB, 'src', 'deep', 'AGENTS.md'), '# repo-b deep rules')
    writeFileSync(join(repoB, 'src', 'deep', 'entry.mjs'), 'export {}\n')
    const world = await mountWorld({}, [repoB])
    expect(textOf(await world.step())).toContain('# repo-b rules')

    // The touch reaches `src/deep`. `src` is only an ANCESTOR of it, and its
    // own file must still be delivered on this very step: the upward discovery
    // walk reports it, but the exact-directory filter would discard it while
    // `src` is never examined.
    world.touch(join(repoB, 'src', 'deep', 'entry.mjs'))
    const text = textOf(await world.step())
    expect(text).toContain('# repo-b src rules')
    expect(text).toContain('# repo-b deep rules')
  })

  it('does not re-send a nested file the model already has', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])
    world.touch(join(repoB, 'src', 'entry.mjs'))
    expect(textOf(await world.step())).toContain('# repo-b src rules')

    world.touch(join(repoB, 'src', 'entry.mjs'))
    expect(await world.step()).toBeUndefined()
  })

  it('re-sends a nested file whose content changed, without a new touch', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])
    world.touch(join(repoB, 'src', 'entry.mjs'))
    expect(textOf(await world.step())).toContain('# repo-b src rules')

    writeFileSync(join(repoB, 'src', 'AGENTS.md'), '# repo-b src revised rules')
    const revised = textOf(await world.step())
    expect(revised).toContain('# repo-b src revised rules')
    expect(revised).not.toContain('# repo-b src rules')
  })

  it('withdraws a nested file that disappeared, naming its absolute path', async () => {
    seedNested()
    writeFileSync(join(repoB, 'src', 'other.mjs'), 'other\n')
    const world = await mountWorld({}, [repoB])
    world.touch(join(repoB, 'src', 'entry.mjs'))
    await world.step()

    rmSync(join(repoB, 'src', 'AGENTS.md'))
    world.touch(join(repoB, 'src', 'other.mjs'))
    const text = textOf(await world.step())
    expect(text).toContain('no longer apply')
    expect(text).toContain(join(repoB, 'src', 'AGENTS.md'))
  })

  it('leaves a subdirectory alone when the session only touched the root', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])
    await world.step()

    world.touch(join(repoB, 'README.md'))
    expect(textOf(await world.step())).not.toContain('# repo-b src rules')
  })

  it('ignores a touch outside every additional root, user-global and outside alike', async () => {
    seedNested()
    writeFileSync(join(dshHome, 'AGENTS.md'), '# user-global rules')
    writeFileSync(join(fixture.outside, 'AGENTS.md'), '# outside rules')
    const world = await mountWorld({}, [repoB])
    await world.step()

    world.touch(join(dshHome, 'AGENTS.md'))
    world.touch(join(fixture.outside, 'AGENTS.md'))
    expect(await world.step()).toBeUndefined()
  })

  it('ignores a touch whose tool call failed, and one made by a non-file tool', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])
    // The root's own file is delivered before any touch, so what follows is only
    // about the touches.
    expect(textOf(await world.step())).toContain('# repo-b rules')

    world.touch(join(repoB, 'src', 'entry.mjs'), { failed: true })
    expect(await world.step()).toBeUndefined()

    world.touch(join(repoB, 'src', 'entry.mjs'), { tool: 'bash' })
    expect(await world.step()).toBeUndefined()
  })

  it('drops a delivered nested file when its root leaves the workspace', async () => {
    seedNested()
    const world = await mountWorld({}, [repoB])
    world.touch(join(repoB, 'src', 'entry.mjs'))
    await world.step()

    world.roots([])
    const text = textOf(await world.step())
    expect(text).toContain(canonicalPath(repoB))
    expect(text).toContain('no longer')
    expect(text).not.toContain('# repo-b src rules')
  })

  it('stays a passthrough with no additional root, even after a touch', async () => {
    writeFileSync(join(fixture.workspace, 'AGENTS.md'), '# primary rules')
    const world = await mountWorld()
    world.touch(join(fixture.workspace, 'AGENTS.md'))
    expect(await world.step()).toBeUndefined()
  })
})

describe('touchedPathOfToolCall', () => {
  it('reads the path out of a raw call, and refuses everything else', () => {
    expect(Instructions.touchedPathOfToolCall('read', '{"file_path":"/tmp/x"}')).toBe('/tmp/x')
    expect(Instructions.touchedPathOfToolCall('write', '{"file_path":" /tmp/x "}')).toBe('/tmp/x')
    expect(Instructions.touchedPathOfToolCall('bash', '{"file_path":"/tmp/x"}')).toBeUndefined()
    expect(Instructions.touchedPathOfToolCall('read', 'not json')).toBeUndefined()
    expect(Instructions.touchedPathOfToolCall('read', '{"file_path":"  "}')).toBeUndefined()
    expect(Instructions.touchedPathOfToolCall('read', '{"file_path":7}')).toBeUndefined()
    expect(Instructions.touchedPathOfToolCall('read', '{"content":"/tmp/x"}')).toBeUndefined()
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
    const rendered = text.slice(text.indexOf('Instructions for additional workspace root'))
    expect(rendered.length).toBeGreaterThan(0)
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
    expect(Instructions.composeInstructionMessage([], [], [])).toBeUndefined()
  })

  it('states that the roots are part of this workspace', () => {
    const text = Instructions.composeInstructionMessage([{ root: '/r', text: 'rules' }], [], [])
    expect(text).toContain('additional roots')
    expect(text).toContain('/r')
    expect(text).toContain('rules')
  })

  it('carries additions and retractions in one message', () => {
    const text = Instructions.composeInstructionMessage([{ root: '/a', text: 'rules' }], ['/b'], [])
    expect(text).toContain('/a')
    expect(text).toContain('/b')
    expect(text).toContain('no longer')
  })

  it('withdraws a removed file in the same message, in path order', () => {
    const text = Instructions.composeInstructionMessage([], [], [
      { root: '/r', path: '/r/z/AGENTS.md' },
      { root: '/r', path: '/r/a/AGENTS.md' },
    ])
    expect(text).toContain('/r/a/AGENTS.md')
    expect(text).toContain('/r/z/AGENTS.md')
    expect(text?.indexOf('/r/a/AGENTS.md')).toBeLessThan(text?.indexOf('/r/z/AGENTS.md') ?? -1)
    expect(text).toContain('no longer apply')
  })
})


describe('delivery bookkeeping under pressure', () => {
  it.each(['omitted', 'truncated'] as const)('retries a nested file that was %s without another touch', async (kind) => {
    const nested = join(repoB, 'src')
    mkdirSync(nested)
    writeFileSync(join(repoB, 'AGENTS.md'), '# root rules')
    writeFileSync(join(nested, 'AGENTS.md'), '# nested complete rules')
    const world = await mountWorld({}, [repoB])
    world.touch(join(nested, 'file.ts'))
    const api = (await instructionsApi())!
    vi.spyOn(api, 'render').mockImplementationOnce(files => ({
      text: '# root rules and possibly partial nested rules',
      omitted: kind === 'omitted' ? [files[1]!] : [],
      truncated: kind === 'truncated' ? [{ displayPath: files[1]!.displayPath, originalBytes: 100, includedBytes: 10 }] : [],
    }))
    await world.step()
    expect(textOf(await world.step())).toContain('# nested complete rules')
    expect(await world.step()).toBeUndefined()
  })

  it('withdraws a partially delivered file if it disappears', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# rules')
    const world = await mountWorld({}, [repoA])
    const api = (await instructionsApi())!
    vi.spyOn(api, 'render').mockImplementationOnce(files => ({
      text: '# partial rules', omitted: [],
      truncated: [{ displayPath: files[0]!.displayPath, originalBytes: 100, includedBytes: 10 }],
    }))
    await world.step()
    rmSync(join(repoA, 'AGENTS.md'))
    expect(textOf(await world.step())).toContain('no longer present')
  })

  it('checks withdrawals in later roots even when the first consumes the budget', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# A')
    writeFileSync(join(repoB, 'AGENTS.md'), '# B')
    const world = await mountWorld({}, [repoA, repoB])
    await world.step()
    writeFileSync(join(repoA, 'AGENTS.md'), '# A changed')
    rmSync(join(repoB, 'AGENTS.md'))
    const api = (await instructionsApi())!
    vi.spyOn(api, 'render').mockReturnValueOnce({ text: 'x'.repeat(Instructions.DEFAULT_MAX_BYTES), omitted: [], truncated: [] })
    expect(textOf(await world.step())).toContain('no longer present')
  })

  it('retries delivery after the message constructor rejects', async () => {
    mkdirSync(join(repoA, 'src'))
    writeFileSync(join(repoA, 'src', 'AGENTS.md'), '# nested rules')
    const world = await mountWorld({}, [repoA])
    world.touch(join(repoA, 'src', 'file.ts'))
    vi.spyOn(LlmMessage, 'createInstructionMessage').mockRejectedValueOnce(new Error('message unavailable'))
    await expect(world.step()).rejects.toThrow('message unavailable')
    expect(textOf(await world.step())).toContain('# nested rules')
    expect(await world.step()).toBeUndefined()
  })

  it('does not commit delivery state when cancellation arrives during message construction', async () => {
    writeFileSync(join(repoA, 'AGENTS.md'), '# rules to retry')
    const world = await mountWorld({}, [repoA])
    const controller = new AbortController()
    const create = LlmMessage.createInstructionMessage
    vi.spyOn(LlmMessage, 'createInstructionMessage').mockImplementationOnce(async input => {
      const message = await create(input)
      controller.abort(new Error('cancelled step'))
      return message
    })
    await expect(world.decide([], controller.signal)).rejects.toThrow('cancelled step')
    expect(textOf(await world.step())).toContain('# rules to retry')
  })

  it('isolates equal tool call ids in different sessions', async () => {
    mkdirSync(join(repoA, 'src'))
    writeFileSync(join(repoA, 'src', 'AGENTS.md'), '# first session nested rules')
    const world = await mountWorld({}, [repoA])
    const sessionId = SessionId('other-session')
    const other = Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: fixture.workspace,
    })
    const complete = world.touch(join(repoA, 'src', 'file.ts'), { callId: 'same', deferResult: true })
    world.touch(join(repoA, 'other.ts'), { callId: 'same', session: other })
    complete()
    expect(textOf(await world.step())).toContain('# first session nested rules')
  })
})
