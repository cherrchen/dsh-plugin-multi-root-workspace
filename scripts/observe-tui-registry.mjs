/** Manual, isolated real-TUI observation; never a substitute for Ubuntu evidence on macOS. */
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: {
  runtime: { type: 'string' }, home: { type: 'string' }, fixture: { type: 'string' },
  output: { type: 'string' }, 'deadline-minutes': { type: 'string', default: '45' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Read-only observation of REAL TUI PTYs (macOS/Linux; Python 3 required).\n'
    + 'Prepare an isolated dsh-tui profile with the observer bundle first.\n'
    + 'Required: --runtime DIR --home DSH_HOME --fixture DIR --output EMPTY_DIR\n'
    + 'Optional: --deadline-minutes 45\n'
    + 'stdin NDJSON: {"start":"owner"}, {"host":"owner","write":"/workspace-folders list"},\n'
    + '{"host":"owner","write":"\\r"}, {"killPid":123,"signal":"SIGKILL"}, {"exit":true}.\n'
    + 'Use separate writes for command text and Enter. No live model credentials are used.')
  process.exit(0)
}
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('PTY bridge requires macOS/Linux')
for (const key of ['runtime', 'home', 'fixture', 'output']) if (!values[key]) throw new Error(`--${key} required`)
const base = resolve(values.output), fixture = resolve(values.fixture), home = resolve(values.home), runtime = resolve(values.runtime)
const helpers = fileURLToPath(new URL('./lib/tui-registry-soak/', import.meta.url))
const deadline = Number(values['deadline-minutes'])
if (!Number.isFinite(deadline) || deadline < 1 || deadline > 180) throw new Error('deadline must be 1..180 minutes')
if (existsSync(base) && readdirSync(base).length) throw new Error('output directory must be empty')
if (!existsSync(join(fixture, 'primary/.git')) || !existsSync(join(fixture, 'additional/.git'))) throw new Error('fixture primary/additional must be separate Git roots')
if (home === join(os.homedir(), '.dsh')) throw new Error('refusing the real DSH_HOME')

const data = join(base, 'user/.dsh-tui'), telemetry = join(base, 'telemetry')
mkdirSync(data, { recursive: true }); mkdirSync(telemetry, { recursive: true })
writeFileSync(join(data, 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
const hosts = new Map(), startedAt = new Map(), paused = new Map(), resumed = new Map(), seen = new Set()
let requestCount = 0
const log = value => {
  const row = { utc: new Date().toISOString(), ...value }
  appendFileSync(join(base, 'events.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}
writeFileSync(join(base, 'configuration.json'), JSON.stringify({ runtime, home, fixture, platform: process.platform, arch: process.arch, node: process.version, execPath: process.execPath, deadlineMinutes: deadline, sampleSeconds: 5, forcedGC: false, externalRssAbortBytes: 2 * 1024 ** 3, sustainedCpuAbortPercent: 60 }, null, 2))
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }, { id: 'deepseek-chat', object: 'model' }] })); return
  }
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const text = JSON.stringify(body)
  const toolResults = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : [])
  const marker = [...text.matchAll(/MRW_WRITE:([a-z0-9-]+)/g)].at(-1)?.[1]
  const isStep = Array.isArray(body.tools) && body.tools.length > 0
  let call
  if (isStep && marker && !seen.has(marker)) {
    seen.add(marker)
    call = { name: 'write', arguments: { file_path: join(fixture, 'additional', marker + '.txt'), content: marker + '\n' } }
  }
  const id = `mrw-${++requestCount}`
  log({ kind: 'model', id, path: req.url, marker, isStep, call, skillBody: text.includes('MRW_SKILL_BODY'), toolResults: toolResults.map(({ tool_use_id, is_error }) => ({ id: tool_use_id, error: is_error })) })
  writeFileSync(join(base, `model-${requestCount}.json`), JSON.stringify(body, null, 2))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (req.url.includes('/messages')) {
    const frame = x => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`
    res.write(frame({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }))
    res.write(frame({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id, name: call.name, input: {} } : { type: 'text', text: '' } }))
    res.write(frame({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text: 'MRW validation complete' } }))
    res.write(frame({ type: 'content_block_stop', index: 0 }))
    res.write(frame({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }))
    res.write(frame({ type: 'message_stop' }))
  } else {
    const frame = x => `data: ${JSON.stringify(x)}\n\n`
    res.write(frame({ choices: [{ delta: { role: 'assistant', content: null } }] }))
    res.write(frame({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: 'MRW validation complete' } }] }))
    res.write(frame({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
    res.write('data: [DONE]\n\n')
  }
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
log({ kind: 'endpoint', port: server.address().port })
function start(label) {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,30}$/.test(label) || hosts.has(label)) throw new Error('use a new short Host label')
  const entry = join(home, 'profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js')
  const child = spawn('python3', [join(helpers, 'bridge.py'), process.execPath, entry], { cwd: join(fixture, 'primary'), env: {
    ...process.env, DSH_HOME: home, DSH_MULTI_ROOT_COMPAT: 'enforce', DSH_PERMISSION_MODE: 'workspace-write', DSH_TUI_WORKSPACE_TARGET: join(fixture, 'primary'), DSH_TUI_BACKEND: 'dsh', DSH_TUI_NO_LAUNCHPAD: '1', DSH_TUI_LANG: 'en',
    NODE_OPTIONS: `--import=${join(helpers, 'preload.mjs')}`, MRW_VALIDATION_USER_HOME: join(base, 'user'),
    MRW_TELEMETRY_DIR: telemetry, MRW_HOST_LABEL: label, TERM: 'xterm-256color', COLORTERM: 'truecolor',
    DEEPSEEK_API_KEY: 'registry-machine-synthetic-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    PATH: join(runtime, 'node_modules/.bin') + ':' + process.env.PATH,
  }, stdio: ['pipe', 'pipe', 'pipe'] })
  hosts.set(label, child)
  startedAt.set(label, Date.now())
  let bytes = 0
  createInterface({ input: child.stdout }).on('line', line => {
    const row = JSON.parse(line)
    if (row.data) {
      const buffer = Buffer.from(row.data, 'base64'); bytes += buffer.length
      if (bytes < 32 * 1024 * 1024) appendFileSync(join(base, `${label}.pty`), buffer)
    } else log({ kind: 'pty', label, ...row })
  })
  child.stderr.on('data', data => appendFileSync(join(base, `${label}.bridge.stderr`), data))
  child.on('error', error => { log({ kind: 'bridge-error', label, message: String(error) }); void shutdown() })
  child.on('exit', code => log({ kind: 'bridge-exit', label, code }))
  log({ kind: 'started', label })
}
createInterface({ input: process.stdin }).on('line', line => {
  try {
    const command = JSON.parse(line)
    log({ kind: 'control', command })
    if (command.start) start(command.start)
    if (command.write) hosts.get(command.host).stdin.write(JSON.stringify({ write: command.write }) + '\n')
    if (command.killPid) {
      // Telemetry is not a durable right to signal a PID: reject PID reuse.
      const match = readdirSync(telemetry).flatMap(file => readFileSync(join(telemetry, file), 'utf8').trim().split('\n').slice(-1).map(JSON.parse)).find(row => row.pid === command.killPid)
      const argv = execFileSync('ps', ['-p', String(command.killPid), '-o', 'command='], { encoding: 'utf8' })
      if (!match || !argv.includes('dsh-tui/lib/types/dsh-adapter/host-entry.js')) throw new Error('PID is not an observed live TUI Host')
      process.kill(command.killPid, command.signal ?? 'SIGKILL')
      if (command.signal === 'SIGSTOP') paused.set(command.killPid, Date.now())
      else paused.delete(command.killPid)
      if (command.signal === 'SIGCONT') resumed.set(command.killPid, Date.now())
    }
    if (command.exit) void shutdown()
  } catch (error) { log({ kind: 'control-error', message: String(error) }) }
}).on('close', () => { void shutdown() })
const watchdog = setInterval(() => {
  for (const [label, child] of hosts) {
    if (child.exitCode !== null) continue
    const file = readdirSync(telemetry).find(file => file.startsWith(`${label}-`))
    if (!file) {
      if (Date.now() - startedAt.get(label) > 60000) { log({ kind: 'missing-telemetry', label }); void shutdown() }
      continue
    }
    const rows = readFileSync(join(telemetry, file), 'utf8').trim().split('\n').slice(-7).map(JSON.parse)
    const latest = rows.at(-1)
    let externalRss = 0
    try { externalRss = Number(execFileSync('ps', ['-p', String(latest.pid), '-o', 'rss='], { encoding: 'utf8' }).trim()) * 1024 } catch { /* Host exit is reported by the bridge. */ }
    // An explicit pause is a fault-injection window, not a wedged observer.
    // Keep RSS/deadline protection and cap the intentional pause at 5 minutes.
    const pausedAt = paused.get(latest.pid)
    const stale = Date.now() - Math.max(Date.parse(latest.utc), resumed.get(latest.pid) ?? 0) > 20000 && pausedAt === undefined
    const pauseExpired = pausedAt !== undefined && Date.now() - pausedAt > 300000
    if (stale || pauseExpired || externalRss > 2 * 1024 ** 3 || latest.rss > 2 * 1024 ** 3 || (rows.length >= 7 && rows.slice(-6).every(x => x.cpuPercent > 60)) || (rows.length > 1 && latest.queries - rows.at(-2).queries > 1000)) {
      log({ kind: 'watchdog-abort', file }); void shutdown(); return
    }
  }
}, 5000)
const hardStop = setTimeout(() => { log({ kind: 'hard-stop' }); void shutdown() }, deadline * 60 * 1000)
let closing = false
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
async function shutdown() {
  if (closing) return
  closing = true
  clearInterval(watchdog); clearTimeout(hardStop)
  for (const child of hosts.values()) if (child.exitCode === null) child.stdin.end(JSON.stringify({ signalGroup: 'SIGTERM' }) + '\n')
  setTimeout(() => { for (const child of hosts.values()) child.kill('SIGKILL'); server.close(); process.exit() }, 3000)
}
