/** Idles a real shared registry on a contended medium, then prints one JSON
 * line of stats: authority kind, diagnostics, scope notification count, and
 * the child's own cpuUsage/heapUsed deltas. */
import { mountRegistryStack } from './registry-stack.ts'
const [storeRoot, secondsText] = process.argv.slice(2)
const stack = await mountRegistryStack(storeRoot, { sharedStorageRoot: storeRoot })
let scopeCalls = 0
const unsubscribe = stack.scope.subscribe(() => { scopeCalls++ })
const cpu0 = process.cpuUsage(), heap0 = process.memoryUsage().heapUsed
await new Promise(resolve => setTimeout(resolve, Number(secondsText ?? '30') * 1000))
const cpu = process.cpuUsage(cpu0), heap = process.memoryUsage().heapUsed - heap0
unsubscribe()
process.stdout.write(JSON.stringify({ authority: stack.registry.authority.kind, diagnostics: stack.registry.diagnostics, scopeCalls, cpu, heap }) + '\n')
await stack.dispose()
