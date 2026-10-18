import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, readFileSync } from 'node:fs'
const { build } = await import('tsdown')
// Independent exact-version companion; ordinary old-runtime builds stay ordinary.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
if (manifest.devDependencies['@deepseek-ai/dsh'] !== '0.2.1-rc.2') {
  console.log('[auto-review] skipped: joint support targets only DSH 0.2.1-rc.2')
} else {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'compat/auto-review/tsconfig.json'], {stdio:'inherit'})
  for (const file of readdirSync('compat/auto-review/lib')) if (/\.(?:m?js)(?:\.map)?$/.test(file)) rmSync(`compat/auto-review/lib/${file}`)
  await build({config:false, entry:['compat/auto-review/src/index.ts'], outDir:'compat/auto-review/lib', tsconfig:'compat/auto-review/tsconfig.json', platform:'node', format:'esm', fixedExtension:false, outputOptions:{entryFileNames:'index.js'}, target:'es2024', dts:false, clean:false,
    deps:{neverBundle: specifier => !specifier.startsWith('.') && !specifier.startsWith('/') }})
}
