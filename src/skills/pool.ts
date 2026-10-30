/** Bounded shared native delegates and one polling scheduler, never per-delegate watchers. */
import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { containsPath } from './reader.ts'
import type { Reader } from './catalog.ts'

interface Entry {
  readonly key: string
  readonly root: string
  readonly controller: AbortController
  readonly reader: Promise<Reader | undefined>
  busy: number
  stamp?: string
}
export class SkillReaderPool {
  private readonly entries = new Map<string, Entry>()
  private readonly waiters = new Set<() => void>()
  private closing = false
  private polling: Promise<void> | undefined
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly invalidate: () => void, readonly capacity = 128, intervalMs = 2000) {
    this.timer = setInterval(() => { void this.poll().catch(() => this.invalidate()) }, intervalMs)
    this.timer.unref()
  }
  get size(): number { return this.entries.size }
  get roots(): readonly string[] { return [...new Set([...this.entries.values()].map(entry => entry.root))] }
  async use<T>(root: string, create: (signal: AbortSignal) => Promise<Reader | undefined>, run: (reader: Reader | undefined) => Promise<T>, signal?: AbortSignal, identity = root): Promise<T> {
    const key = identity
    for (;;) {
      signal?.throwIfAborted()
      if (this.closing) throw new Error('multi-root skills: reader pool is closing')
      let entry = this.entries.get(key)
      if (entry === undefined && this.entries.size >= this.capacity) {
        const idle = [...this.entries.values()].find(entry => entry.busy === 0)
        if (idle === undefined) {
          await new Promise<void>((resolve, reject) => {
            const wake = () => { signal?.removeEventListener('abort', abort); this.waiters.delete(wake); resolve() }
            const abort = () => { this.waiters.delete(wake); reject(signal?.reason) }
            this.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
          })
          continue
        }
        this.entries.delete(idle.key); await this.closeEntry(idle)
        continue
      }
      if (entry === undefined) {
        const controller = new AbortController()
        entry = { key, root, controller, reader: create(controller.signal), busy: 0 }
        this.entries.set(key, entry)
      }
      this.entries.delete(key); this.entries.set(key, entry); entry.busy++
      try {
        if (entry.stamp === undefined) entry.stamp = await skillTreeStamp(entry.root)
        signal?.throwIfAborted()
        return await run(await entry.reader)
      } finally {
        entry.busy--
        for (const wake of [...this.waiters]) wake()
      }
    }
  }
  async poll(): Promise<void> {
    if (this.closing) return
    this.polling ??= (async () => {
      let changed = false
      for (const entry of [...this.entries.values()]) {
        const stamp = await skillTreeStamp(entry.root)
        if (entry.stamp !== undefined && entry.stamp !== stamp) changed = true
        entry.stamp = stamp
      }
      if (changed && !this.closing) this.invalidate()
    })().finally(() => { this.polling = undefined })
    await this.polling
  }
  async dispose(): Promise<void> {
    this.closing = true; clearInterval(this.timer)
    for (const wake of [...this.waiters]) wake()
    for (const entry of this.entries.values()) entry.controller.abort()
    await this.polling?.catch(() => {})
    // Each caller's run is owned by the service's drain. Wake on every release.
    while ([...this.entries.values()].some(entry => entry.busy > 0)) await new Promise<void>(resolve => { const wake = () => { this.waiters.delete(wake); resolve() }; this.waiters.add(wake) })
    await Promise.allSettled([...this.entries.values()].map(entry => this.closeEntry(entry)))
    this.entries.clear()
  }
  private async closeEntry(entry: Entry): Promise<void> {
    entry.controller.abort()
    try { await (await entry.reader)?.dispose() } catch { /* Failed optional construction owns no delegate. */ }
  }
}

/** No symlink target outside the Root is read or enumerated. Content reads stay on demand. */
export async function skillTreeStamp(root: string): Promise<string> {
  const rows: string[] = [canonicalPath(root)]
  const stamp = async (path: string, identityOnly = false) => {
    try {
      const link = await lstat(path, { bigint: true })
      // Ordinary root-file creation changes directory mtime/size/ctime, but
      // does not change the Skills catalog. Keep root identity/permissions so
      // replacement/disappearance still invalidates pending readers.
      rows.push(identityOnly
        ? `${path}:${link.dev}:${link.ino}:${link.mode}:${canonicalPath(path)}`
        : `${path}:${link.dev}:${link.ino}:${link.size}:${link.mtimeNs}:${link.ctimeNs}:${canonicalPath(path)}`)
      if (!containsPath(root, canonicalPath(path))) return undefined
      return await stat(path)
    } catch { rows.push(`${path}:missing`); return undefined }
  }
  await stamp(root, true)
  for (const directory of ['.dsh/skills', '.agents/skills']) {
    const path = join(root, directory)
    const info = await stamp(path)
    if (!info?.isDirectory()) continue
    const entries = await readdir(path).catch(() => [])
    for (const name of entries.sort()) {
      const candidate = join(path, name), info = await stamp(candidate)
      if (info?.isDirectory()) await stamp(join(candidate, 'SKILL.md'))
    }
  }
  return rows.join('\n')
}
