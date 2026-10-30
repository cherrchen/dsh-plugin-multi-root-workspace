/** Verify native shared-Registry capability before the matrix can skip tests.
 * Run after build; uses the same public diagnostic as the installed bundle.
 */
import { nativeHostAvailability } from '../lib/registry.js'

const availability = await nativeHostAvailability()
if (availability.available) {
  console.log(`[registry:probe] ${process.platform}: native Host peer authentication is available; shared IPC tests must run`)
} else {
  console.log(`[registry:probe] ${process.platform}: unavailable: ${availability.reason}`)
  if (process.argv.includes('--required')) {
    throw new Error('this native CI runner must exercise shared Registry IPC; capability skips are not acceptance evidence')
  }
}
