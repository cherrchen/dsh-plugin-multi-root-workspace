/** Scoped takeover of public Loader entries; no profile file is written. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { wrapMethod } from '../method-wrapper.ts'

export const OFFICIAL_AUTO_REVIEW = '@deepseek-ai/dsh-experimental-auto-review'
export const LEGACY_AUTO_REVIEW = '@dsh-electron/dsh-plugin-multi-root-auto-review'

// Identity is the row's module name within OUR OWN entry group: the official
// bundle inserts `auto-review` as a top-level row, so it always lands in the
// same group as this entry. An official-named row in a nested group would be
// someone else's plugin and is deliberately out of scope. When no official
// row exists (bundle not selected) the fork simply runs standalone — there is
// nothing to take over, and the reviewer still self-registers the Auto preset.

interface Options {
  id: string
  name: string
  disabled?: unknown
  [key: string]: unknown
}
interface Group {
  ctx: Context
  data: Options[]
  tree: { store: Record<string, Entry> }
  update(config: Options[]): Promise<void>
  create(options: Options): Promise<string>
  remove(id: string): void
}
interface Entry {
  options: Options
  parent: Group
  fiber?: Fiber
  disabled: boolean
  evaluate(expression: string): unknown
}

// A replacement fiber may start before its predecessor's async cleanup has
// finished. Keep desired configuration and a drain barrier across that handoff.
const takeovers = new WeakMap<Group, AutoReviewTakeover>()

/**
 * internal/plugin is emitted before Fiber checks dependencies or runs apply.
 * Disposing there also stops an import already in flight when takeover began.
 * The group update wrapper preserves desired configuration and drains our
 * owner BEFORE the update that lets the official owner run again.
 */
export class AutoReviewTakeover {
  private readonly entry: Entry
  private readonly group: Group
  private readonly restoreUpdate: () => void
  private readonly predecessor: Promise<void>
  private readonly closed: Promise<void>
  private releaseClosed!: () => void
  readonly stopHook: () => void
  private desired: Options[]
  private stopOwner: () => Promise<void> = async () => {}
  private closing: Promise<void> | undefined
  private readonly draining = new Set<Promise<void>>()

  constructor(private readonly ctx: Context) {
    const entry = (ctx.fiber as Fiber & { entry?: Entry }).entry
    if (entry === undefined) throw new Error('multi-root Auto Review must be mounted as a Loader entry')
    this.entry = entry
    this.group = entry.parent
    const previous = takeovers.get(this.group)
    if (previous !== undefined && previous.entry !== entry && previous.closing === undefined) {
      throw new Error('Only one multi-root Auto Review Loader entry may own a group')
    }
    this.desired = structuredClone(previous?.desired ?? this.group.data)
    if (this.desired.some(row => row.name === LEGACY_AUTO_REVIEW)) {
      throw new Error('Remove the legacy @dsh-electron/dsh-plugin-multi-root-auto-review package/bundle before enabling the built-in Auto Review entry')
    }
    this.predecessor = previous?.closed ?? Promise.resolve()
    this.closed = new Promise(resolve => { this.releaseClosed = resolve })
    previous?.restoreUpdate()
    takeovers.set(this.group, this)
    const self = this
    this.restoreUpdate = wrapMethod(this.group, 'update', original => function (this: Group, config: Options[]): Promise<void> {
      self.desired = structuredClone(config)
      if (config.some(row => row.name === LEGACY_AUTO_REVIEW)) {
        return Promise.reject(new Error('Remove the legacy multi-root Auto Review companion before reloading this profile'))
      }
      const own = config.find(row => row.id === self.entry.options.id)
      if (own === undefined || own.name !== self.entry.options.name || self.isDisabled(own)) {
        // Start Loader's own disposal synchronously. Include does not await
        // group.update(), and loader.await() only sees entry import/inertia
        // tasks. Deferring this call would let reconciliation report success
        // before the reviewer/context had actually stopped.
        self.entry.options.disabled = true
      }
      // Official restoration is part of our awaited disposer, after drain.
      return Reflect.apply(original, this, [config.filter(row => row.name !== OFFICIAL_AUTO_REVIEW)])
    })
    this.stopHook = ctx.on('internal/plugin', fiber => {
      const candidate = (fiber as Fiber & { entry?: Entry }).entry
      if (fiber.uid === null || candidate?.parent !== this.group || candidate.options.name !== OFFICIAL_AUTO_REVIEW) return
      this.suppress(candidate, fiber)
    }, { global: true })
  }

  private isDisabled(options: Options): boolean {
    const value = options.disabled
    return typeof value === 'object' && value !== null && '__jsExpr' in value
      ? Boolean(this.entry.evaluate(String(value.__jsExpr))) : Boolean(value)
  }

  private suppress(entry: Entry, fiber = entry.fiber): void {
    // Loader itself uses this order to avoid persisting a transient stop.
    entry.options.disabled = true
    if (this.group.tree.store[entry.options.id] === entry) this.group.remove(entry.options.id)
    if (fiber === undefined) return
    const task = Promise.resolve(fiber.dispose()).then(async () => { await fiber.await() })
    this.draining.add(task)
    void task.finally(() => this.draining.delete(task)).catch(error => this.ctx.logger.error(error))
  }

  async suspendOfficial(): Promise<void> {
    await this.predecessor
    for (const entry of Object.values(this.group.tree.store)) {
      if (entry.parent === this.group && entry.options.name === OFFICIAL_AUTO_REVIEW) this.suppress(entry)
    }
    await Promise.all([...this.draining])
  }

  /** Called before any asynchronous startup, so early unload also drains it. */
  setOwnerDisposer(stop: () => Promise<void>): void { this.stopOwner = stop }

  close(restore = true): Promise<void> {
    return this.closing ??= this.finish(restore).finally(() => this.releaseClosed())
  }

  private async finish(restore: boolean): Promise<void> {
    await this.stopOwner()
    await Promise.all([...this.draining])
    this.stopHook()
    this.restoreUpdate()
    // Restore from the latest desired input after drain; loss of a required
    // service must not select a fallback. A successor owns restoration now.
    if (!restore || takeovers.get(this.group) !== this || !this.entry.disabled || this.group.ctx.fiber.state === 5 || this.group.ctx.fiber.uid === null) return
    for (const [index, options] of this.desired.entries()) {
      if (options.name !== OFFICIAL_AUTO_REVIEW || this.group.tree.store[options.id] !== undefined) continue
      const copy = structuredClone(options)
      this.group.data.splice(Math.min(index, this.group.data.length), 0, copy)
      const id = await this.group.create(copy)
      const restored = this.group.tree.store[id]
      await restored?.fiber?.await()
    }
    takeovers.delete(this.group)
  }
}
