import { writeFileSync } from 'node:fs'

/** Save comparable case outcomes, including the notes passed to context.skip(). */
export default class CaseReporter {
  onTestRunEnd(modules) {
    const cases = modules.flatMap(module => Array.from(module.children.allTests(), test => {
      const { state, note } = test.result()
      return { file: module.relativeModuleId, name: test.fullName, state, ...(note && { note }) }
    }))
    writeFileSync(process.env.DSH_CI_VITEST_REPORT, JSON.stringify(cases) + '\n')
  }
}
