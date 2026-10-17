import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { removeBehaviorHome } from '../../scripts/lib/smoke-cleanup.mjs'

const require = createRequire(import.meta.url)
require('koffi')
const source = Object.keys(require.cache).find(path => path.endsWith('.node') && path.includes('koffi'))
assert.ok(source, 'loaded the real native addon')
const root = process.argv[2]
const native = join(root, 'profiles', 'plugin', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node')
mkdirSync(dirname(native), { recursive: true })
copyFileSync(source, native)
require(native)
assert.throws(() => unlinkSync(native), { code: 'EPERM' }, 'Windows keeps the addon mapped until exit')
console.log('native addon is mapped')
await removeBehaviorHome(root, process.argv[3] === 'defer')
assert.ok(existsSync(native), 'the parent owns the still-mapped file')
