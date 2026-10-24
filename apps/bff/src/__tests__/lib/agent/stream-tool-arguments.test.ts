import { describe, expect, it } from 'bun:test'
import {
  AgentToolArgumentsTooLargeError,
  withToolArgumentLimit,
} from '../../../lib/agent/stream-tool-arguments'

const encoder = new TextEncoder()

const event = (delta: object) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`

const argumentEvents = (text: string, step: number) => {
  let body = event({
    tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'runNodes' } }],
  })
  for (let i = 0; i < text.length; i += step)
    body += event({ tool_calls: [{ index: 0, function: { arguments: text.slice(i, i + step) } }] })
  return body
}

/** 按固定块长切开 SSE 文本推送，`hang` 时推完不收尾，模拟仍在吐字的上游；记下上游是否被取消。 */
function sseFetch(body: string, chunkSize: number, hang = false) {
  const seen = { cancelled: false }
  const fetchFn = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < body.length; i += chunkSize)
            controller.enqueue(encoder.encode(body.slice(i, i + chunkSize)))
          if (!hang) controller.close()
        },
        cancel() {
          seen.cancelled = true
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  return { fetchFn, seen }
}

describe('model stream tool-argument limit', () => {
  it('passes a stream whose tool arguments stay within the limit through unchanged', async () => {
    const body = `${argumentEvents('{"nodeIds":["a","b"]}', 4)}data: [DONE]\n\n`
    const { fetchFn } = sseFetch(body, 7)
    const response = await withToolArgumentLimit(fetchFn, 64)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })

  it('fails a runaway tool call and cancels the upstream stream', async () => {
    // 不收尾：失控的上游会一直吐下去，必须由这一层截断。
    const { fetchFn, seen } = sseFetch(argumentEvents('['.repeat(5_000), 8), 300, true)
    const response = await withToolArgumentLimit(fetchFn, 1_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
    expect(seen.cancelled).toBe(true)
  }, 2_000)

  it('counts arguments across SSE events split mid-line and multibyte characters', async () => {
    const { fetchFn } = sseFetch(argumentEvents('雨'.repeat(200), 3), 5)
    const response = await withToolArgumentLimit(fetchFn, 150)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
  })

  it('sums arguments of parallel tool calls in one model response', async () => {
    let body = ''
    for (let i = 0; i < 40; i++)
      body += event({
        tool_calls: [
          { index: 0, function: { arguments: 'aaaaa' } },
          { index: 1, function: { arguments: 'bbbbb' } },
        ],
      })
    const { fetchFn } = sseFetch(body, 64)
    const response = await withToolArgumentLimit(fetchFn, 300)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
  })

  it('fails a line that keeps growing without a newline', async () => {
    const { fetchFn, seen } = sseFetch(
      `data: {"choices":[{"delta":{"content":"${'x'.repeat(20_000)}`,
      500,
      true,
    )
    const response = await withToolArgumentLimit(fetchFn, 1_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
    expect(seen.cancelled).toBe(true)
  }, 2_000)

  it('does not count streamed text toward the tool-argument limit', async () => {
    let body = ''
    for (let i = 0; i < 50; i++) body += event({ content: '雨夜旧车站'.repeat(10) })
    const { fetchFn } = sseFetch(body, 128)
    const response = await withToolArgumentLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })
})
