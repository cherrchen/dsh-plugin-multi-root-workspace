#!/usr/bin/env node
// Scripted OpenAI-compatible model endpoint for the GUI probe.
// Logs every request path; answers model list + both SSE wire dialects.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/dsh-model-requests.log'
const frame = p => `data: ${JSON.stringify(p)}\n\n`
const event = p => `event: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`

const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${req.url}\n`)
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed.tools)) appendFileSync(LOG, `TOOLS:${JSON.stringify(parsed.tools.map(t => t.function?.name ?? t.name))}\n`)
      appendFileSync('/tmp/dsh-model-body-last.json', body)
    } catch {}
    const url = req.url ?? ''
    if (req.method === 'GET' && /models/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
      ] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (url.includes('/v1/messages')) {
      for (const p of [
        { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 2 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'gui probe turn complete' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]) res.write(event(p))
    } else {
      for (const p of [
        { choices: [{ delta: { role: 'assistant', content: null } }] },
        { choices: [{ delta: { content: 'gui probe turn complete' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]) res.write(frame(p))
      res.write('data: [DONE]\n\n')
    }
    res.end()
  })
})
server.listen(18778, '127.0.0.1', () => console.log('scripted model on 127.0.0.1:18778'))
