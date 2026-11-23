#!/usr/bin/env node
/** Published entry point for the exact-version SSH dependency installer. */
import { main } from '../lib/install-ssh-deps.js'

const outcome = await main(process.argv.slice(2))
const stream = outcome.code === 0 ? process.stdout : process.stderr
stream.write(outcome.message + '\n')
process.exitCode = outcome.code
