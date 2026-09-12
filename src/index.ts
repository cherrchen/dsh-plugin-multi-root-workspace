/**
 * Barrel for the multi-root workspace bundle's host half.
 *
 * This entry is a plain re-export surface with no side effects: the loader
 * mounts the plugin through the subpath entries declared in `package.json` and
 * `cordis.patch.yml` (`./fs`, `./sandbox`, `./scope`), never through this one.
 * It exists so the package root resolves and so tests can import the whole
 * public surface from a single specifier.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace
 */

export { MultiRootFileSystem } from './fs.ts'
export type { Config as FileSystemConfig } from './fs.ts'
export { MultiRootSandboxProvider } from './sandbox.ts'
export type { Config as SandboxConfig } from './sandbox.ts'
export { MultiRootScopeService, sanitizeAdditionalRoots } from './scope.ts'
export type { AdditionalWorkspaceRoot, FilesystemScope } from './scope.ts'
