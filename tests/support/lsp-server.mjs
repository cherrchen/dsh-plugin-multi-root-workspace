// Minimal protocol peer: reports the actual initialize roots and process cwd.
let buffer = Buffer.alloc(0)
let initialization
let document
function reply(id, result) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
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
      case 'textDocument/hover': reply(message.id, { contents: { kind: 'plaintext', value: JSON.stringify({ cwd: process.cwd(), rootUri: initialization.rootUri, workspaceFolders: initialization.workspaceFolders, document, pid: process.pid }) } }); break
      case 'textDocument/definition': reply(message.id, [{ uri: document.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]); break
      case 'shutdown': reply(message.id, null); break
      case 'exit': process.exit(0); break
    }
  }
})
