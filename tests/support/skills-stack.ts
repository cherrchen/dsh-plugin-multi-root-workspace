/** Real native services over the production Registry; Agent handles use real Session logs. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import NativeSkills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import { mountRegistryStack } from './registry-stack.ts'
import MultiRootSkills from '../../src/skills.ts'
import { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller'

export async function skillsStack(base: string) {
  const stack = await mountRegistryStack(join(base, 'store'), {}, { beforeGate: async ctx => {
    await ctx.plugin(LocalFs, { cwd: base })
  } })
  const ctx = stack.ctx
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry); await ctx.plugin(NativeSkills)
  await ctx.plugin(FileSkills, { includeDefaultRoots: true, dshHome: join(base, 'home'), agentsHome: join(base, 'agents'), watch: false })
  ctx.provide('workingDirectory', { ensure: async (agent: Agent) => (agent as Agent & { effectiveCwd?: string }).effectiveCwd ?? agent.session.header.cwd } as never)
  const headers = new Map<string, Session['header']>()
  ctx.provide('sessionQuery', { observeSession: async (id: string) => {
    const header = headers.get(id)
    if (!header) throw new Error('unknown session')
    return { header, projections: { values: { workingDirectory: join(base, 'shared') } }, [Symbol.dispose]() {} }
  } } as never)
  const remote = new SessionSkillCatalog(ctx)
  await ctx.plugin(ToolSkill)
  const rawSnapshot = ctx.skills.snapshot
  const rawGet = Object.getOwnPropertyDescriptor(ctx.skills, 'get')
  const rawSnapshotDescriptor = Object.getOwnPropertyDescriptor(ctx.skills, 'snapshot')
  const owner = await ctx.plugin(MultiRootSkills)
  const releaseAgents: (() => void)[] = []
  function agent(cwd: string) {
    const id = SessionId(randomUUID())
    const session = Session.create(id, [], { id, cwd, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
    const agent = { id, session, ctx, effectiveCwd: join(base, 'shared') } as unknown as Agent & { effectiveCwd: string }
    headers.set(id, session.header); releaseAgents.push(ctx.agents.enter(agent, undefined))
    return agent
  }
  return { ...stack, ctx, owner, agent, headers, remote, rawSnapshot, rawGet, rawSnapshotDescriptor,
    snapshot: (agent: Agent & { effectiveCwd: string }) => ctx.skills.snapshot({ cwd: agent.effectiveCwd, scope: agent }),
    preStep: (agent: Agent, messages: UserMessage[] = []) => agentEvents(ctx, agent).waterfall('agent/pre-step', { turn: 1, step: 1, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages })),
    dispose: async () => { for (const release of releaseAgents) release(); await stack.dispose() },
  }
}
export function writeSkill(root: string, name: string, body: string, metadata = '', directory = '.dsh/skills') {
  const path = join(root, directory, name, 'SKILL.md'); mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n${metadata}---\n${body}\n`)
  return path
}
export function project(base: string, name: string): string { const root = join(base, name); mkdirSync(join(root, '.git'), { recursive: true }); return root }
