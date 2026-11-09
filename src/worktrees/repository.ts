/**
 * The activation snapshot: is this directory the root of a supported Git
 * checkout, and which metadata does it use?
 *
 * Two checkout shapes are supported (ADR-0039 §2.4):
 *
 * - `main` — `<root>/.git` is a real directory; the checkout is the repository
 *   root itself, not a subdirectory of one;
 * - `linked` — `<root>/.git` is a regular file holding `gitdir: <admin>`, the
 *   admin lives in `<common>/worktrees/<id>`, and `commondir` names the
 *   shared git dir.
 *
 * Everything is proven from metadata the plugin opened and parsed itself. No
 * Git subprocess is ever started, no commit object is resolved and `objects`
 * is never read. The full ancestor chain is walked for BOTH shapes, so an
 * embedded repository that a parent repository later registered as a
 * `160000` gitlink is inactive even when the nearest ancestor is silent.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/repository
 */

import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { samePath } from '../roots.ts'
import { snapshotGitConfig } from './config.ts'
import {
  canonicalExisting,
  directoryIdentity,
  lstatEntry,
  MAX_ALTERNATES_BYTES,
  MAX_HEAD_BYTES,
  MAX_INDEX_BYTES,
  MAX_POINTER_BYTES,
  readPointerLine,
  readRegularFile,
  readUtf8File,
  resolvePointerTarget,
  SafeIoError,
} from './fs-safe.ts'
import { GITLINK_MODE, lookupGitlink, parseGitIndex } from './index-format.ts'
import type { ActivationFailure, ActivationResult, ConfigSnapshot, FileIdentity, RepoSnapshot } from './types.ts'

/** The one parser both `HEAD` files and the pointer snapshots share. */
export interface HeadVerdict {
  readonly ok: true
  readonly value: string
}
export interface HeadRefusal {
  readonly ok: false
  readonly detail: string
}

/** Git's refname grammar, the subset that proves a `ref:` line is a ref. */
function validRefname(refname: string): boolean {
  if (!refname.startsWith('refs/')) return false
  if (refname.endsWith('/')) return false
  if (refname.includes('..') || refname.includes('@{') || refname.includes('//')) return false
  // Control characters, space, and the characters Git forbids in refnames.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(refname)) return false
  for (const component of refname.split('/')) {
    if (component === '' || component.startsWith('.') || component.endsWith('.') || component.endsWith('.lock')) return false
  }
  return true
}

/**
 * Validate one `HEAD` file's text.
 * @param text - the decoded file contents.
 * @param hexLength - the object id width the object format implies (40 for v1).
 * @returns the normalized single-line value, or the reason it is not a HEAD.
 */
export function validateHeadText(text: string, hexLength = 40): HeadVerdict | HeadRefusal {
  let value = text
  if (value.endsWith('\n')) value = value.slice(0, -1)
  // eslint-disable-next-line no-control-regex
  if (value === '' || /[\u0000-\u001f\u007f]/.test(value) || value.includes('\n')) {
    return { ok: false, detail: 'HEAD is empty, multi-line, or contains a control character' }
  }
  if (value.startsWith('ref:')) {
    if (!value.startsWith('ref: ')) return { ok: false, detail: 'HEAD ref line is malformed' }
    const refname = value.slice(5)
    if (!validRefname(refname)) return { ok: false, detail: `HEAD names an invalid ref ${JSON.stringify(refname)}` }
    return { ok: true, value }
  }
  if (!new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(value)) {
    return { ok: false, detail: 'HEAD is neither a ref line nor an object id of the expected width' }
  }
  return { ok: true, value }
}

/** Read and validate one HEAD file. */
function readHead(path: string, hexLength: number): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly detail: string } {
  const text = readUtf8File(path, MAX_HEAD_BYTES)
  return validateHeadText(text, hexLength)
}

/** Read a one-line pointer file (commondir / gitdir) and resolve it. */
function readOneLinePointer(path: string, base: string): string {
  return resolvePointerTarget(base, readPointerLine(path))
}

/** Read `<root>/.git`, which must be a regular file, and resolve its admin. */
function readGitFilePointer(gitFile: string, root: string): string {
  const line = readPointerLine(gitFile)
  const prefix = 'gitdir: '
  if (!line.startsWith(prefix)) throw new SafeIoError('invalid-path', `${gitFile} is not a gitdir pointer`)
  return resolvePointerTarget(root, line.slice(prefix.length))
}

/** Refuse a common git dir whose object store can reach outside itself. */
function assertNoAlternates(common: string): void {
  const objects = join(common, 'objects')
  const info = join(objects, 'info')
  const entry = lstatEntry(info)
  if (entry === undefined) return
  if (entry === 'symlink') throw new SafeIoError('symlink', `${info} is a symlink`)
  if (entry !== 'directory') throw new SafeIoError('not-directory', `${info} is not a directory`)
  for (const name of ['alternates', 'http-alternates']) {
    const file = join(info, name)
    const alternate = lstatEntry(file)
    if (alternate === undefined) continue
    if (alternate === 'symlink') throw new SafeIoError('symlink', `${file} is a symlink`)
    if (alternate !== 'file') throw new SafeIoError('not-file', `${file} is not a regular file`)
    const text = readUtf8File(file, MAX_ALTERNATES_BYTES)
    const meaningful = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
    if (meaningful.length > 0) throw new UnsupportedLayout(`${file} declares an alternate object store`)
  }
}

/** Read a directory's identity, refusing a platform that cannot provide one. */
function requireIdentity(path: string): FileIdentity {
  const identity = directoryIdentity(path)
  if (identity === undefined) throw new IdentityUnavailable(path)
  return identity
}

/** Internal signal for "this file system gives us no stable directory id". */
class IdentityUnavailable extends Error {
  constructor(readonly path: string) {
    super(`the file system provides no stable identity for "${path}"`)
  }
}

/** The internal layout of one supported checkout. */
interface CheckoutLayout {
  readonly shape: 'main' | 'linked'
  readonly root: string
  readonly gitDir: string
  readonly common: string
  readonly adminId?: string
  readonly adminGitdir?: string
  readonly config: ConfigSnapshot
  readonly head: string
  readonly adminHead?: string
  readonly rootIdentity: FileIdentity
  readonly adminIdentity: FileIdentity
}

/** Validate the common repository structure the ADR requires. */
function commonStructure(common: string, platform: NodeJS.Platform): ConfigSnapshot {
  const config = snapshotGitConfig(readUtf8File(join(common, 'config'), MAX_POINTER_BYTES * 16), platform)
  if (!config.ok) throw new UnsupportedConfig(config.detail)
  if (config.config.bare) throw new UnsupportedLayout('the common repository is bare (core.bare=true)')
  const head = readHead(join(common, 'HEAD'), 40)
  if (!head.ok) throw new InvalidHead(head.detail)
  for (const directory of ['objects', 'refs']) {
    const entry = lstatEntry(join(common, directory))
    if (entry === undefined) throw new UnsupportedLayout(`the common git dir has no ${directory} directory`)
    if (entry === 'symlink' || entry !== 'directory') throw new UnsafeMetadata(`the common ${directory} is not a real directory`)
  }
  assertNoAlternates(common)
  return config.config
}

/** Internal refusal classes, mapped to stable reasons by {@link resolveRepo}. */
class UnsupportedLayout extends Error {}
class UnsupportedConfig extends Error {}
class InvalidHead extends Error {}
class UnsafeMetadata extends Error {}

/** Resolve the checkout layout of one canonical root, without ancestry. */
function resolveLayout(root: string, platform: NodeJS.Platform): CheckoutLayout {
  const gitEntry = join(root, '.git')
  const entry = lstatEntry(gitEntry)
  if (entry === undefined) throw new NotACheckout(`"${root}" has no .git entry`)
  if (entry === 'symlink') throw new UnsafeMetadata(`"${gitEntry}" is a symlink`)
  const rootIdentity = requireIdentity(root)
  if (entry === 'directory') {
    const config = commonStructure(gitEntry, platform)
    const head = readHead(join(gitEntry, 'HEAD'), 40)
    if (!head.ok) throw new InvalidHead(head.detail)
    return {
      shape: 'main',
      root,
      gitDir: gitEntry,
      common: gitEntry,
      config,
      head: head.value,
      rootIdentity,
      adminIdentity: requireIdentity(gitEntry),
    }
  }
  if (entry !== 'file') throw new UnsafeMetadata(`"${gitEntry}" is neither a directory nor a regular file`)
  const admin = readGitFilePointer(gitEntry, root)
  const adminEntry = lstatEntry(admin)
  if (adminEntry === undefined) throw new UnsafeMetadata(`the admin git dir "${admin}" does not exist`)
  if (adminEntry === 'symlink' || adminEntry !== 'directory') throw new UnsafeMetadata(`the admin git dir "${admin}" is not a real directory`)
  const commondir = join(admin, 'commondir')
  const commondirEntry = lstatEntry(commondir)
  if (commondirEntry === undefined) {
    throw new UnsupportedLayout('the checkout .git file has no admin commondir (submodule or --separate-git-dir main checkout)')
  }
  if (commondirEntry === 'symlink' || commondirEntry !== 'file') throw new UnsafeMetadata(`"${commondir}" is not a regular file`)
  const common = readOneLinePointer(commondir, admin)
  const adminId = basename(admin)
  if (adminId === '' || adminId === '.' || adminId === '..' || !samePath(dirname(admin), join(common, 'worktrees'))) {
    throw new UnsupportedLayout(`the admin git dir "${admin}" is not inside <common>/worktrees`)
  }
  const gitdirFile = join(admin, 'gitdir')
  const gitdirEntry = lstatEntry(gitdirFile)
  if (gitdirEntry === undefined) throw new UnsupportedLayout('the admin git dir has no gitdir back-pointer')
  if (gitdirEntry === 'symlink' || gitdirEntry !== 'file') throw new UnsafeMetadata(`"${gitdirFile}" is not a regular file`)
  const back = readOneLinePointer(gitdirFile, admin)
  if (!samePath(back, gitEntry)) throw new UnsupportedLayout('the admin gitdir does not point back at this checkout')
  const config = commonStructure(common, platform)
  const commonHead = readHead(join(common, 'HEAD'), 40)
  if (!commonHead.ok) throw new InvalidHead(`common HEAD: ${commonHead.detail}`)
  const adminHead = readHead(join(admin, 'HEAD'), 40)
  if (!adminHead.ok) throw new InvalidHead(`admin HEAD: ${adminHead.detail}`)
  return {
    shape: 'linked',
    root,
    gitDir: admin,
    common,
    adminId,
    adminGitdir: admin,
    config,
    head: adminHead.value,
    adminHead: adminHead.value,
    rootIdentity,
    adminIdentity: requireIdentity(admin),
  }
}

/** Internal signal for "this directory is not a checkout root". */
class NotACheckout extends Error {}

/**
 * Read one ancestor repository's index and ask whether it records `root` as a
 * submodule. `undefined` means "this layer is negative"; an exception means
 * the layer cannot be judged and the whole activation is refused.
 */
function ancestorGitlink(ancestor: string, root: string, platform: NodeJS.Platform): boolean | undefined {
  const dotGit = join(ancestor, '.git')
  const entry = lstatEntry(dotGit)
  if (entry === undefined) return undefined
  if (entry === 'symlink') throw new UnprovableAncestor(`"${dotGit}" is a symlink`)
  let configDir: string
  let indexPath: string
  if (entry === 'directory') {
    configDir = dotGit
    indexPath = join(dotGit, 'index')
  } else if (entry === 'file') {
    const admin = readGitFilePointer(dotGit, ancestor)
    const commonFile = join(admin, 'commondir')
    const commonEntry = lstatEntry(commonFile)
    if (commonEntry === undefined) throw new UnprovableAncestor(`ancestor "${ancestor}" is a submodule or separate-git-dir checkout`)
    if (commonEntry === 'symlink' || commonEntry !== 'file') throw new UnprovableAncestor(`"${commonFile}" is not a regular file`)
    configDir = readOneLinePointer(commonFile, admin)
    indexPath = join(admin, 'index')
  } else {
    throw new UnprovableAncestor(`"${dotGit}" is neither a directory nor a regular file`)
  }
  const configFile = join(configDir, 'config')
  const configResult = snapshotGitConfig(readUtf8File(configFile, MAX_POINTER_BYTES * 16), platform)
  if (!configResult.ok) throw new UnprovableAncestor(`ancestor config "${configFile}": ${configResult.detail}`)
  const indexEntry = lstatEntry(indexPath)
  // A repository with no index has registered no gitlink yet; that is a
  // negative observation, not an unprovable one.
  if (indexEntry === undefined) return undefined
  if (indexEntry === 'symlink') throw new UnprovableAncestor(`ancestor index "${indexPath}" is a symlink`)
  if (indexEntry !== 'file') throw new UnprovableAncestor(`ancestor index "${indexPath}" is not a regular file`)
  const parsed = parseGitIndex(readRegularFile(indexPath, MAX_INDEX_BYTES))
  if (!parsed.ok) throw new UnprovableAncestor(`ancestor index "${indexPath}": ${parsed.detail}`)
  // POSIX keeps a literal backslash inside one file name; only Windows treats
  // it as a separator. Splitting every backslash would make `vendor\lib` look
  // like `vendor/lib` and miss a real `160000` entry.
  const relativePath = relative(ancestor, root)
  const path = (platform === 'win32' ? relativePath.split(/[\\/]+/) : relativePath.split('/')).join('/')
  if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path)) {
    throw new UnprovableAncestor(`cannot express "${root}" relative to ancestor "${ancestor}"`)
  }
  const lookup = lookupGitlink(parsed.index, path, configResult.config, platform)
  if (!lookup.ok) throw new UnprovableAncestor(`ancestor index "${indexPath}": ${lookup.detail}`)
  if (lookup.mode === undefined) return undefined
  if (lookup.mode === GITLINK_MODE) return true
  return undefined
}

/** Internal signal for "an ancestor cannot be ruled out". */
class UnprovableAncestor extends Error {}

/**
 * Walk EVERY ancestor repository. A negative nearest ancestor does not end the
 * walk: an outer repository may still register a deeper directory as a
 * gitlink while an intermediate independent repository shadows it.
 */
function assertNotSubmodule(root: string, platform: NodeJS.Platform): void {
  let current = dirname(root)
  for (;;) {
    try {
      const hit = ancestorGitlink(current, root, platform)
      if (hit === true) throw new SubmoduleCheckout(current)
    } catch (error) {
      if (error instanceof SubmoduleCheckout || error instanceof UnprovableAncestor) throw error
      // Any metadata failure inside an ancestor layer means the gitlink cannot
      // be ruled out; the ADR requires inactive, not a guess.
      throw new UnprovableAncestor(`ancestor "${current}" could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Internal signal for "an ancestor index records this checkout as a gitlink". */
class SubmoduleCheckout extends Error {
  constructor(readonly ancestor: string) {
    super(`"${ancestor}" records this checkout as a submodule (mode 160000)`)
  }
}

/** Map one metadata refusal to a stable activation reason. */
function mapIoError(error: SafeIoError): { readonly reason: ActivationFailure; readonly detail: string } {
  switch (error.reason) {
    case 'missing': return { reason: 'not-a-checkout', detail: error.message }
    case 'inaccessible': return { reason: 'inaccessible', detail: error.message }
    case 'not-directory': case 'not-file': return { reason: 'unsafe-metadata', detail: error.message }
    default: return { reason: 'unsafe-metadata', detail: error.message }
  }
}

/**
 * Resolve one directory's activation snapshot.
 * @param directory - the checkout root as the caller knows it (verbatim).
 * @param options - platform override for tests/probes.
 * @returns the snapshot, or the stable reason it is inactive.
 */
export function resolveRepo(directory: string, options: { readonly platform?: NodeJS.Platform } = {}): ActivationResult {
  const platform = options.platform ?? process.platform
  try {
    // Validate the verbatim primary before canonicalizing its geometry.
    // The Registry key still belongs to the caller's upstream spelling.
    const canonical = canonicalExisting(directory)
    const layout = resolveLayout(canonical, platform)
    assertNotSubmodule(canonical, platform)
    const repo: RepoSnapshot = {
      shape: layout.shape,
      canonical: layout.root,
      common: layout.common,
      gitDir: layout.gitDir,
      ...(layout.adminId === undefined ? {} : { adminId: layout.adminId }),
      ...(layout.adminGitdir === undefined ? {} : { adminGitdir: layout.adminGitdir }),
      ...(layout.adminHead === undefined ? {} : { adminHead: layout.adminHead }),
      head: layout.head,
      config: layout.config,
      rootIdentity: layout.rootIdentity,
      adminIdentity: layout.adminIdentity,
    }
    return { ok: true, repo }
  } catch (error) {
    if (error instanceof NotACheckout) return { ok: false, reason: 'not-a-checkout', detail: error.message }
    if (error instanceof UnsupportedLayout) return { ok: false, reason: 'unsupported-layout', detail: error.message }
    if (error instanceof UnsupportedConfig) return { ok: false, reason: 'unsupported-config', detail: error.message }
    if (error instanceof InvalidHead) return { ok: false, reason: 'invalid-head', detail: error.message }
    if (error instanceof UnsafeMetadata) return { ok: false, reason: 'unsafe-metadata', detail: error.message }
    if (error instanceof SubmoduleCheckout) return { ok: false, reason: 'submodule', detail: error.message }
    if (error instanceof UnprovableAncestor) return { ok: false, reason: 'unprovable-ancestor', detail: error.message }
    if (error instanceof IdentityUnavailable) return { ok: false, reason: 'unstable-identity', detail: error.message }
    if (error instanceof SafeIoError) return { ok: false, ...mapIoError(error) }
    return { ok: false, reason: 'inaccessible', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether two snapshots describe the same checkout — the fields an `addNew`
 * `expected` snapshot binds. Identities are compared only when both sides
 * have one.
 * @param left - the recorded snapshot.
 * @param right - the fresh snapshot.
 * @returns whether the checkout is unchanged.
 */
export function sameCheckout(left: RepoSnapshot, right: RepoSnapshot): boolean {
  if (left.shape !== right.shape) return false
  if (!samePath(left.canonical, right.canonical)) return false
  if (!samePath(left.common, right.common)) return false
  if ((left.adminId ?? '') !== (right.adminId ?? '')) return false
  if ((left.adminGitdir ?? '') !== (right.adminGitdir ?? '')) return false
  if ((left.adminHead ?? '') !== (right.adminHead ?? '')) return false
  if (!identityMatches(left.rootIdentity, right.rootIdentity)) return false
  if (!identityMatches(left.adminIdentity, right.adminIdentity)) return false
  return true
}

/** Compare optional identities; both must exist to count as a match. */
export function identityMatches(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return false
  if (left.dev !== right.dev || left.ino !== right.ino) return false
  if (left.birthtimeMs !== undefined && right.birthtimeMs !== undefined && left.birthtimeMs !== right.birthtimeMs) return false
  return true
}

export { validateHeadText as validateHead }
