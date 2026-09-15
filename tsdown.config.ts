/**
 * Two build faces, one package:
 *
 * - the **host** face (ESM, `platform: 'node'`) with every production package
 *   left external, because the host provides exactly one instance of each
 *   service-definition package and of cordis (see ADR-0002);
 * - the **browser** face (CJS, `platform: 'browser'`) emitted as the module
 *   loader's closure factory — the only artifact shape the Web client accepts.
 *
 * The browser face's externals are exactly the module-table words both
 * supported runtimes seed (`0.1.5-rc.2` seeds one more, `ui-dockkit`, which
 * this plugin deliberately does not use). Everything else is inlined, so the
 * panel owns no runtime identity it would have to share.
 *
 * @module tsdown.config
 */

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

/**
 * Module-table specifiers the browser bundle may import at runtime. React and
 * cordis are shared identities the shell seeds; the client packages below are
 * provided by the composed client graph. Anything else — including this
 * package's own modules — is inlined.
 */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const hostConfig: UserConfig = {
  name: PACKAGE_NAME,
  entry: [
    'src/index.ts',
    'src/compat.ts',
    'src/fs.ts',
    'src/sandbox.ts',
    'src/scope.ts',
    'src/registry.ts',
    'src/instructions.ts',
    'src/command.ts',
  ],
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
}

const clientConfig: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
  },
  // Browser bundles inline libraries that probe the bundler's environment
  // variables (zustand, immer and friends); the substitutions keep the closure
  // factory from throwing on a bare `process` or `import.meta` reference.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The module loader's contract: a factory registered under the exact
    // package name, with a synchronous `require` for the module table.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostConfig, clientConfig])

function packageName(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier
  return specifier.split('/').slice(0, 2).join('/')
}
