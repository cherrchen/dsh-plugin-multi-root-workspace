import { readFileSync } from 'node:fs'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'

interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as Manifest

// Production packages stay external: the host provides exactly one instance of
// each service-definition package and of cordis, so bundling our own copy would
// fork the Service identity (see ADR-0002).
const productionPackages = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
])

export default defineConfig({
  name: PACKAGE_NAME,
  entry: ['src/index.ts', 'src/fs.ts', 'src/sandbox.ts', 'src/scope.ts'],
  tsconfig: 'tsconfig.host.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => productionPackages.has(packageName(specifier)),
  },
}) satisfies UserConfig

function packageName(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier
  return specifier.split('/').slice(0, 2).join('/')
}
