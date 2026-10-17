import { describe, expect, it } from 'vitest'
import { classifyOutcome } from './support/dialect-grants.ts'

describe('native runner evidence classification', () => {
  const rules = [{ fatalSignatures: ['landlock-run: '], informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'] }]
  it('does not reject successful enforcement because an older kernel reported a completeness caveat', () => {
    expect(classifyOutcome({ status: 0, stdout: 'wrote', stderr: 'landlock-run: partial enforcement (older Landlock ABI)' }, [], rules))
      .toEqual({ kind: 'ok', stdout: 'wrote' })
    expect(classifyOutcome({ status: 1, stdout: '', stderr: 'landlock-run: partial enforcement (older Landlock ABI)\nPermission denied' }, ['permission denied'], rules))
      .toMatchObject({ kind: 'denied' })
  })
  it('still rejects real startup failures even when accompanied by denial text', () => {
    expect(classifyOutcome({ status: 1, stdout: '', stderr: 'landlock-run: cannot restrict\nPermission denied' }, ['permission denied'], rules))
      .toMatchObject({ kind: 'runner-failed' })
  })
})
