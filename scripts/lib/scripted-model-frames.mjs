/**
 * One scripted turn in the chat-completions wire dialect.
 *
 * Deltas carry the whole tool call in one chunk; the smoke is scripting a model,
 * not testing the harness's stream reassembly.
 * @param call - the tool call to emit, or `undefined` to close the turn.
 * @param text - the assistant text used when closing the turn.
 * @param id - the tool call id.
 * @returns SSE frames, in order.
 */
export function chatCompletionFrames(call, text, id) {
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  return [
    frame({ choices: [{ delta: { role: 'assistant', content: null } }] }),
    call === undefined
      ? frame({ choices: [{ delta: { content: text } }] })
      : frame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            }],
          },
        }],
      }),
    frame({
      choices: [{ delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
    'data: [DONE]\n\n',
  ]
}

/**
 * The same scripted turn in the block-oriented Messages wire dialect.
 *
 * This protocol has a stricter contract than chat completions, and all of it is
 * load-bearing here: every event names its `type`, the named SSE event must
 * agree with it, each content block is explicitly opened and closed, and the
 * stream must settle with a stop reason before `message_stop` or the harness
 * rejects it as malformed.
 * @param call - the tool call to emit, or `undefined` to close the turn.
 * @param text - the assistant text used when closing the turn.
 * @param id - the tool call id.
 * @returns SSE frames, in order.
 */
export function messagesFrames(call, text, id) {
  const frame = payload => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  const block = call === undefined
    ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    ]
    : [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: call.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } },
      { type: 'content_block_stop', index: 0 },
    ]
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ...block,
    { type: 'message_delta', delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use' } },
    { type: 'message_stop' },
  ].map(frame)
}

