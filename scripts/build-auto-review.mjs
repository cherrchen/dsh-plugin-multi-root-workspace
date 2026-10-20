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
  // Production packages stay external (the host provides exactly one instance,
  // the same contract as tsdown.config.ts). Rolldown re-checks externals with
  // RESOLVED ids, so a prefix test on '.' and '/' mislabels `C:\…` sources as
  // dependencies on Windows; matching manifest names is separator-proof.
  const companion = JSON.parse(readFileSync(new URL('../compat/auto-review/package.json', import.meta.url)))
  const production = new Set([...Object.keys(companion.dependencies ?? {}), ...Object.keys(companion.peerDependencies ?? {})])
  await build({config:false, entry:['compat/auto-review/src/index.ts'], outDir:'compat/auto-review/lib', tsconfig:'compat/auto-review/tsconfig.json', platform:'node', format:'esm', fixedExtension:false, outputOptions:{entryFileNames:'index.js'}, target:'es2024', dts:false, clean:false,
    deps:{neverBundle: specifier => production.has(packageName(specifier))}})
  // One emitted entry, every own source inlined: a surviving relative import
  // is a file the packed artifact does not ship — fail here, not at `dsh
  // plugin add` on one operating system.
  for (const match of readFileSync('compat/auto-review/lib/index.js', 'utf8')
    .matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier !== undefined && specifier.startsWith('.')) throw new Error(`[auto-review] lib/index.js keeps unresolved import ${specifier}`)
  }
}

function packageName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}
