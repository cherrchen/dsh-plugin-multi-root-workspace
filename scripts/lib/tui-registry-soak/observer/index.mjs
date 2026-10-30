// Read-only telemetry over public Host services; no refresh or admission here.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapSpaceStatistics } from 'node:v8'
export const inject = ['multiRootRegistry', 'skills']
export function apply(ctx) {
  const registry = ctx.multiRootRegistry, skills = ctx.skills
  const compat = ctx.get('multiRootCompat')
  const dir = process.env.MRW_TELEMETRY_DIR
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${process.env.MRW_HOST_LABEL}-${process.pid}.jsonl`)
  let queries = 0, changes = 0, publications = 0
  const descriptor = Object.getOwnPropertyDescriptor(skills, 'snapshot')
  const original = skills.snapshot
  Object.defineProperty(skills, 'snapshot', { configurable: true, writable: true, value: function(...args) {
    queries++; return original.apply(this, args)
  } })
  ctx.on('skills/change', () => { changes++ })
  ctx.effect(() => registry.onChange(() => { publications++ }))
  let lastCpu = process.cpuUsage(), lastTime = process.hrtime.bigint()
  const sample = () => {
    const now = process.hrtime.bigint(), cpu = process.cpuUsage()
    const seconds = Number(now - lastTime) / 1e9
    const cpuPercent = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1e6 / seconds * 100
    lastCpu = cpu; lastTime = now
    appendFileSync(file, JSON.stringify({ utc: new Date().toISOString(), pid: process.pid, argv: process.argv,
      queries, changes, publications, authority: registry.authority.kind, epoch: registry.epoch,
      cwd: process.cwd(), release: compat?.release, supported: compat?.supported, shared: registry.shared,
      roots: registry.list(process.cwd()).map(({ path, state, access, skillsEnabled }) => ({ path, state, access, skillsEnabled })),
      cpuPercent, ...process.memoryUsage(), oldSpace: getHeapSpaceStatistics().find(s => s.space_name === 'old_space')?.space_used_size }) + '\n')
  }
  sample()
  const timer = setInterval(sample, 5000)
  timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer); sample()
    if (descriptor) Object.defineProperty(skills, 'snapshot', descriptor)
    else delete skills.snapshot
  })
}
