import { expect, it } from 'bun:test'
import { observeOverloadResponse } from '../../../lib/agent/overload-response'

it('passes oversized and malformed frames through without treating ordinary text as overload', async () => {
  for (const data of [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'overloaded '.repeat(10000) } }] })}\n\n`,
    'data: {broken json}\n\n',
    'data: {"choices":[{"delta":{"content":"server_overloaded"}}]}\n\n',
  ]) {
    const observed = observeOverloadResponse(
      new Response(data, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture' },
      }),
    )
    expect(await observed.response.text()).toBe(data)
    expect(observed.response.headers.get('x-request-id')).toBe('fixture')
    expect(observed.isRejected('overloaded connection reset')).toBe(false)
  }
})

it('propagates cancellation to the upstream body', async () => {
  let reason: unknown
  const observed = observeOverloadResponse(
    new Response(
      new ReadableStream({
        cancel(value) {
          reason = value
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  )
  await observed.response.body!.cancel('user stopped')
  expect(reason).toBe('user stopped')
})

it('recognizes multiline CRLF error events split across chunks', async () => {
  const data =
    'event: error\r\ndata: {"error":\r\ndata: {"type":"overloaded_error","message":"Busy"}}\r\n\r\n'
  const observed = observeOverloadResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const character of data) controller.enqueue(new TextEncoder().encode(character))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  )
  expect(await observed.response.text()).toBe(data)
  expect(observed.isRejected('Busy')).toBe(true)
})
