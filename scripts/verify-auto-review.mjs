/** Both source and publication-shaped installations, on every supported host OS. */
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { removeScratchTree } from './lib/smoke-cleanup.mjs'
for (const packed of ['0','1']) {
  // A packed child maps the installed koffi.node inside its scratch home, and
  // Windows cannot delete a mapped addon until that child exits — so the
  // parent owns ALL home cleanup after close (the smoke-packed contract).
  const home = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  const child=spawn(process.execPath,[fileURLToPath(new URL('./smoke-auto-review.mjs',import.meta.url))],{stdio:'inherit',env:{...process.env,DSH_AUTO_REVIEW_PACKED:packed,DSH_SMOKE_HOME:home,DSH_SMOKE_DEFER_HOME_CLEANUP:'1'}})
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
  try { await removeScratchTree(home) } finally { if(code!==0)process.exit(code??1) }
}
