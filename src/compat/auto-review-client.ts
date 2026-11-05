/**
 * Client seam for the optional Auto Review loader row.
 *
 * The row ships `disabled: true` in `cordis.patch.yml`; its only switch is the
 * Loader entry's own enablement, which the Plugin Manager persists as a
 * profile `{ id, disabled }` override through `pluginManager.setPluginEnabled`.
 * This module binds that Remote namespace lazily — hosts without the Plugin
 * Manager simply never attach, and the settings row stays hidden — and mirrors
 * the Plugin Manager's own row semantics: the same entry id, the same
 * `plugin-manager/changed` refresh, and the same `applied` /
 * `restart-required` outcome split.
 *
 * Everything here is structural on purpose: the namespace is an optional
 * service, so no module-level `inject` may name it, and the wire shapes are
 * narrowed to the fields this card reads rather than imported from the
 * generated Remote types.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/auto-review-client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { clientInject } from './skills-client.ts'

/** The module specifier `cordis.patch.yml` gives the optional row. */
export const AUTO_REVIEW_MODULE = '@dsh-electron/dsh-plugin-multi-root-workspace/auto-review'

/** The row's live state, narrowed to what the settings card renders. */
export interface AutoReviewRowView {
  readonly entryId: string
  readonly enabled: boolean
  /** Whether `setPluginEnabled` may address this entry (no read-only reason). */
  readonly writable: boolean
  /** Startup failure text while the entry's fiber is failed. */
  readonly diagnostic?: string
}

export interface AutoReviewSnapshot {
  /**
   * `unavailable` — the `pluginManager` namespace never attached (old host or
   * headless composition): the row renders nothing. `loading` — attached, the
   * first `listPlugins` is in flight. `ready` — `row` is present exactly when
   * the composition lists our module. `error` — the last read failed.
   */
  readonly status: 'unavailable' | 'loading' | 'ready' | 'error'
  readonly row?: AutoReviewRowView
}

/** What one enable/disable write resolved to. */
export type AutoReviewWriteResult = 'applied' | 'restart-required' | 'failed'

/** The card's handle: a snapshot source plus the row's one write. */
export interface AutoReviewForm {
  getSnapshot(): AutoReviewSnapshot
  subscribe(listener: () => void): () => void
  setEnabled(enabled: boolean): Promise<AutoReviewWriteResult>
}

/** The `pluginManager` Remote namespace, narrowed to the two calls used here. */
interface PluginManagerRemote {
  listPlugins(): Promise<RemoteResult<readonly PluginRowInfo[]>>
  setPluginEnabled(id: string, enabled: boolean): Promise<RemoteResult<PluginChangeResult>>
}

/** One `listPlugins` row, narrowed to the fields the card reads. */
interface PluginRowInfo {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly readOnlyReason?: string
  readonly diagnostic?: string
}

/** The `setPluginEnabled` outcome, narrowed to the application verdict. */
interface PluginChangeResult {
  readonly application?: string
}

/** The slice of the `remote` service the change feed needs. */
interface RemoteEventFace {
  $on(event: string, listener: () => void): () => void
}

class AutoReviewSettingsForm implements AutoReviewForm {
  private snapshot: AutoReviewSnapshot = { status: 'unavailable' }
  private readonly listeners = new Set<() => void>()
  private manager: PluginManagerRemote | undefined
  private stopEvents: (() => void) | undefined
  // Bumped on every attach/detach so a `listPlugins` answer that lands after
  // the namespace went away cannot publish a stale row.
  private epoch = 0
  // Bumped on every refresh so only the newest `listPlugins` answer may
  // publish: an older response landing last must not overwrite newer state.
  private refreshSeq = 0

  getSnapshot(): AutoReviewSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: AutoReviewSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  attach(manager: PluginManagerRemote, remote: RemoteEventFace | undefined): void {
    this.detach()
    this.manager = manager
    this.epoch++
    this.publish({ status: 'loading' })
    if (remote !== undefined) {
      try {
        this.stopEvents = remote.$on('plugin-manager/changed', () => { void this.refresh() })
      } catch {
        // A host that does not forward the event still works: writes refresh
        // explicitly, the switch just will not track row-side changes live.
        this.stopEvents = undefined
      }
    }
    void this.refresh()
  }

  detach(): void {
    this.stopEvents?.()
    this.stopEvents = undefined
    this.manager = undefined
    this.epoch++
    this.publish({ status: 'unavailable' })
  }

  private async refresh(): Promise<void> {
    const manager = this.manager
    const epoch = this.epoch
    const seq = ++this.refreshSeq
    if (manager === undefined) return
    const result = await manager.listPlugins()
    if (manager !== this.manager || epoch !== this.epoch || seq !== this.refreshSeq) return
    if (!result.ok) {
      this.publish({ status: 'error' })
      return
    }
    const entry = result.value.find(item => item.moduleName === AUTO_REVIEW_MODULE)
    this.publish(entry === undefined ? { status: 'ready' } : {
      status: 'ready',
      row: {
        entryId: entry.entryId,
        enabled: entry.enabled,
        writable: entry.readOnlyReason === undefined,
        ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
      },
    })
  }

  async setEnabled(enabled: boolean): Promise<AutoReviewWriteResult> {
    const manager = this.manager
    const row = this.snapshot.status === 'ready' ? this.snapshot.row : undefined
    if (manager === undefined || row === undefined) return 'failed'
    const result = await manager.setPluginEnabled(row.entryId, enabled)
    // The write already persisted; refresh so the switch shows the stored
    // state even when the change event never reaches this client.
    await this.refresh()
    if (!result.ok) return 'failed'
    const application = result.value.application
    return application === 'applied' || application === 'restart-required' ? application : 'failed'
  }
}

/**
 * Create the card's Auto Review handle and attach it when the host's
 * `pluginManager` namespace arrives. The returned form exists immediately with
 * status `unavailable` and publishes on every attach/detach/read, so callers
 * only need `subscribe` — no separate availability callback.
 * @param ctx - the client root context.
 * @returns the stable form the settings row renders.
 */
export function installAutoReviewSettings(ctx: Context): AutoReviewForm {
  const form = new AutoReviewSettingsForm()
  clientInject(ctx, ['remote.pluginManager'], scope => {
    const manager = scope.get('remote.pluginManager' as never) as PluginManagerRemote | undefined
    if (manager === undefined) return
    const remote = scope.get('remote' as never) as RemoteEventFace | undefined
    form.attach(manager, remote)
    return () => { form.detach() }
  })
  return form
}
