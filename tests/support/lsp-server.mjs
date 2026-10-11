// Minimal protocol peer: reports the actual initialize roots and process cwd.
// Document text containing SLOW_HOVER delays the hover reply 3000 ms (a
// $/cancelRequest for that id answers -32800 instead); CRASH_HOVER exits 3.
let buffer = Buffer.alloc(0)
let initialization
let document
const canceled = []
const pendingHovers = new Map()
function send(body) {
  const bytes = Buffer.from(JSON.stringify(body))
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`)
  process.stdout.write(bytes)
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function hoverResult() {
  return { contents: { kind: 'plaintext', value: JSON.stringify({ cwd: process.cwd(), rootUri: initialization.rootUri, workspaceFolders: initialization.workspaceFolders, document, canceled, pid: process.pid }) } }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    switch (message.method) {
      case 'initialize':
        initialization = message.params
        reply(message.id, { capabilities: { positionEncoding: 'utf-16', hoverProvider: true, definitionProvider: true, textDocumentSync: { openClose: true, change: 1 } } })
        break
      case 'textDocument/didOpen': document = message.params.textDocument; break
      case 'textDocument/hover': {
        const text = document?.text ?? ''
        if (text.includes('CRASH_HOVER')) { process.exit(3) }
        if (text.includes('SLOW_HOVER')) {
          pendingHovers.set(message.id, setTimeout(() => {
            pendingHovers.delete(message.id)
            reply(message.id, hoverResult())
          }, 3000))
          break
        }
        reply(message.id, hoverResult())
        break
      }
      case '$/cancelRequest': {
        canceled.push(message.params?.id)
        const pending = pendingHovers.get(message.params?.id)
        if (pending !== undefined) {
          pendingHovers.delete(message.params?.id)
          clearTimeout(pending)
          send({ jsonrpc: '2.0', id: message.params.id, error: { code: -32800, message: 'canceled' } })
        }
        break
      }
      case 'textDocument/definition': reply(message.id, [{ uri: document.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]); break
      case 'shutdown': reply(message.id, null); break
      case 'exit': process.exit(0); break
    }
  }
})
