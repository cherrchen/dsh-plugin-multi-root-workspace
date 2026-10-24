/** Session-addressed Connection cache. Every refresh and change notification fences old replies. */
import { PANEL_CHANNEL } from '../contract.ts'
import { skillsCatalogSchema, skillsPreviewSchema, skillsStatusSchema, type SkillsCatalogView, type SkillsPreviewView } from '../skills-contract.ts'
interface Connection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } }
interface State { pending?: Promise<SkillsCatalogView>; epoch: number; value?: SkillsCatalogView; request?: AbortController; watching?: AbortController; listeners: Set<() => void> }
export class SkillsClient {
  private readonly states = new Map<string, State>()
  private closed = false
  constructor(private readonly connection: Connection) {}
  private state(id: string): State {
    let state = this.states.get(id)
    if (state === undefined) { state = { epoch: 0, listeners: new Set() }; this.states.set(id, state) }
    return state
  }
  private async call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const result = await this.connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as { ok: boolean; value?: unknown; error?: { message?: string } }
    signal?.throwIfAborted()
    if (!result.ok) throw new Error(result.error?.message ?? 'Skills request failed')
    return result.value
  }
  async list(sessionId: string, signal?: AbortSignal): Promise<SkillsCatalogView> {
    if (this.closed) throw new Error('Skills client is closed')
    const state = this.state(sessionId)
    if (state.pending === undefined) {
      const epoch = ++state.epoch
      state.request?.abort(); const request = new AbortController(); state.request = request
      const pending = (async () => {
        const value = skillsCatalogSchema.parse(await this.call('skillsList', { sessionId }, request.signal))
        if (this.closed || value.sessionId !== sessionId || epoch !== state.epoch) throw new Error('Stale Skills response')
        const changed = JSON.stringify(state.value) !== JSON.stringify(value)
        state.value = value
        if (changed) for (const listener of state.listeners) listener()
        return value
      })()
      state.pending = pending
      void pending.then(() => { if (state.pending === pending) delete state.pending }, () => { if (state.pending === pending) delete state.pending })
    }
    return await withAbort(state.pending, signal)
  }

  snapshot(sessionId: string): SkillsCatalogView | undefined { return this.states.get(sessionId)?.value }
  async preview(sessionId: string, name: string, signal?: AbortSignal): Promise<SkillsPreviewView> {
    const state = this.state(sessionId), epoch = state.epoch
    const value = skillsPreviewSchema.parse(await this.call('skillsPreview', { sessionId, name }, signal))
    if (this.closed || epoch !== state.epoch || value.sessionId !== sessionId || value.name !== name) throw new Error('Stale Skills preview')
    return value
  }
  subscribe(sessionId: string, listener: () => void): () => void {
    const state = this.state(sessionId); state.listeners.add(listener)
    if (state.watching === undefined) {
      const lifetime = new AbortController(); state.watching = lifetime
      void this.watch(sessionId, state, lifetime.signal)
    }
    return () => {
      state.listeners.delete(listener)
      if (state.listeners.size === 0) { state.watching?.abort(); delete state.watching; state.request?.abort(); this.states.delete(sessionId) }
    }
  }
  private invalidate(state: State): void {
    state.epoch++; state.request?.abort(); delete state.pending; delete state.value
    for (const listener of state.listeners) listener()
  }
  reset(): void { for (const state of this.states.values()) this.invalidate(state) }
  dispose(): void {
    this.closed = true
    for (const state of this.states.values()) { this.invalidate(state); state.watching?.abort() }
    this.states.clear()
  }
  private async watch(id: string, state: State, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.closed) {
      try {
        const current = state.value ?? await this.list(id, signal)
        const next = skillsStatusSchema.parse(await this.call('skillsChanges', { sessionId: id, generation: current.generation }, signal))
        if (next.sessionId !== id) throw new Error('Wrong Skills Session')
        if (next.generation !== current.generation) this.invalidate(state)
      } catch {
        if (signal.aborted || this.closed) return
        this.invalidate(state)
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true })
        })
      }
    }
  }
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
