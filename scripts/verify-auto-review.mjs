/** Both source and publication-shaped installations, on every supported host OS. */
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
for (const packed of ['0','1']) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./smoke-auto-review.mjs',import.meta.url))],{stdio:'inherit',env:{...process.env,DSH_AUTO_REVIEW_PACKED:packed}})
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
  if(code!==0)process.exit(code??1)
}
