/**
 * Bounded idle-degradation soak: a child process runs a real shared Registry
 * against a contended medium (the parent holds the lock, nothing listens)
 * for ~30 wall seconds on REAL timers. The assertion is the quietness
 * contract: a bounded number of background attempts, zero scope churn, and
 * near-zero CPU/heap growth — the idle drain must not spin.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { RegistryAuthorityLease } from '../src/registry-lease.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
const nativeTest = it.skipIf(!availability.available)
let fixture: FixtureWorkspace, lease: RegistryAuthorityLease | undefined
beforeEach(() => { fixture = createFixtureWorkspace('recovery-soak') })
afterEach(async () => { await lease?.release(); lease = undefined; fixture.dispose() })

nativeTest('an idle contended host stays silent and cheap across the backoff ladder', async () => {
  const root = join(fixture.base, 'store')
  mkdirSync(root)
  lease = await RegistryAuthorityLease.acquire(join(root, 'multi_root_workspace.lock'))
  const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./support/registry-idle-child.ts', import.meta.url)), root, '30'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'close')
  const line = stdout.trim().split('\n').pop() ?? ''
  const report = JSON.parse(line || '{}') as {
    authority: string; scopeCalls: number; cpu: { user: number; system: number }; heap: number
    diagnostics: { recovery: { attempts: number } }
  }
  expect(code, `${line}\n${stderr}`).toBe(0)
  expect(report.authority).toBe('contended')
  // Backoff ladder: ~1+2+4+8+16s → 5 attempts in 30s; jitter allows ≤7.
  expect(report.diagnostics.recovery.attempts).toBeLessThanOrEqual(7)
  expect(report.scopeCalls).toBe(0)
  expect(report.cpu.user + report.cpu.system).toBeLessThan(1_500_000)
  expect(report.heap).toBeLessThan(20 * 1024 * 1024)
}, 60_000)
