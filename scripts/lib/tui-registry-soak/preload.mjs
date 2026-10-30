// Isolate TUI preferences without changing HOME or the installed package.
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
if (process.env.MRW_VALIDATION_USER_HOME) {
  os.homedir = () => process.env.MRW_VALIDATION_USER_HOME
  syncBuiltinESMExports()
}
