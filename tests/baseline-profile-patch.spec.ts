import { expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { baselineProfilePatch } from '../scripts/lib/baseline-profile-patch.mjs'

it('patches the host and actual preset tool rows while preserving lazy YAML conditions', () => {
  const source = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  disabled: true
  config: { applyPatch: false }
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: tool-bash
        disabled: !!js process.platform === 'win32'
      - id: tool-fs
        config: { applyPatch: false, read: true }
`
  const patch = baselineProfilePatch(source, true)
  expect(patch.targets).toEqual(['tool-fs', 'preset-standard'])
  const doc = parseDocument(patch.yaml, { logLevel: 'silent' })
  expect(doc.getIn([1, 'config', 'plugins', 0, 'disabled'], true).tag).toBe('tag:yaml.org,2002:js')
  expect(doc.getIn([1, 'config', 'plugins', 1, 'config', 'applyPatch'])).toBe(true)
  expect(doc.getIn([1, 'config', 'plugins', 1, 'config', 'read'])).toBe(true)
  expect(doc.getIn([1, 'config', 'id'])).toBe('standard')
  expect(baselineProfilePatch(patch.yaml, false).yaml).toContain('applyPatch: false')
})

it('fails on an unknown composition instead of pretending to enable a tool', () => {
  expect(() => baselineProfilePatch('[]', true)).toThrow('G0_NO_TOOL_FS_ROW')
  expect(() => baselineProfilePatch('not: rows', true)).toThrow('G0_BAD_COMPOSITION')
})
