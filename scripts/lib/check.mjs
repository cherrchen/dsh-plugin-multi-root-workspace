/**
 * Minimal assertion helper for the smoke scripts.
 *
 * The smokes are plain Node programs (they drive a real dsh process), so they
 * cannot borrow vitest's expect. Every check is recorded with its description
 * and reported together at the end, which makes a failing smoke readable in CI
 * instead of stopping at the first mismatch.
 *
 * @module scripts/lib/check
 */

/**
 * Create a checker that collects labelled assertions.
 * @param label - the smoke's name, used in the summary.
 * @returns the checker's assertion and reporting functions.
 */
export function createChecker(label) {
  const failures = []
  const skipped = []
  let passed = 0

  const record = (ok, message, detail) => {
    if (ok) {
      passed += 1
      return
    }
    failures.push({ message, detail })
  }

  return {
    /** Assert a condition. */
    ok(condition, message, detail) {
      record(condition === true, message, detail)
    },
    /**
     * Assert deep equality through JSON comparison.
     * @param detail - optional caller-supplied evidence (e.g. the recorded
     *   outcome the assertion read); printed on failure so a red run is
     *   diagnosable from its log alone.
     */
    equal(actual, expected, message, detail) {
      const left = JSON.stringify(actual)
      const right = JSON.stringify(expected)
      record(left === right, message, left === right ? undefined : `expected ${right}\n  actual   ${left}${detail === undefined ? '' : `\n  evidence ${JSON.stringify(detail)}`}`)
    },
    /** Assert a substring is present, with the same optional evidence line. */
    contains(haystack, needle, message, detail) {
      record(
        typeof haystack === 'string' && haystack.includes(needle),
        message,
        `missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}${detail === undefined ? '' : `\n  evidence ${JSON.stringify(detail)}`}`,
      )
    },
    /**
     * Record an assertion this environment cannot make.
     *
     * The outer harness sandbox on some hosts refuses a nested kernel sandbox
     * (`sandbox-exec: sandbox_apply: Operation not permitted`), so a smoke must
     * say so explicitly instead of passing silently or failing for a reason that
     * has nothing to do with the plugin.
     */
    skip(message) {
      skipped.push(message)
    },
    /** Print the summary; exit non-zero when anything failed. */
    finish() {
      const total = passed + failures.length
      if (skipped.length > 0) {
        console.log(`\n[smoke:${label}] ${skipped.length} assertion(s) skipped in this environment:`)
        for (const message of skipped) console.log(`  - ${message}`)
      }
      if (failures.length === 0) {
        console.log(`\n[smoke:${label}] ${passed}/${total} checks passed`)
        return
      }
      console.error(`\n[smoke:${label}] ${failures.length} of ${total} checks FAILED`)
      for (const failure of failures) {
        console.error(`  ✗ ${failure.message}`)
        if (failure.detail !== undefined) console.error(`      ${failure.detail.split('\n').join('\n      ')}`)
      }
      throw new Error(`smoke:${label} failed`)
    },
  }
}
