import { describe, expect, it } from 'bun:test'
import { createParser } from 'eventsource-parser'
import {
  AGENT_SSE_LINE_MAX_CHARS,
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
          const bytes = encoder.encode(body)
          for (let i = 0; i < bytes.length; i += chunkSize)
            controller.enqueue(bytes.slice(i, i + chunkSize))
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

function toolArguments(body: string): string[] {
  const args: string[] = []
  const parser = createParser({
    onEvent({ data }) {
      if (data === '[DONE]') return
      const chunk = JSON.parse(data)
      for (const choice of chunk.choices ?? [])
        for (const call of choice.delta?.tool_calls ?? []) {
          const value = call.function?.arguments ?? call.custom?.input
          if (typeof value === 'string') args.push(value)
        }
    },
  })
  parser.feed(body)
  return args
}

describe('model stream tool-argument limit', () => {
  it.each(['\n', '\r\n', '\r'])('counts multiline SSE data with %j endings', async (ending) => {
    const payload = JSON.stringify(
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'x'.repeat(101) } }],
            },
          },
        ],
      },
      null,
      2,
    )
    const body = `${payload
      .split('\n')
      .map((line) => `data: ${line}`)
      .join(ending)}${ending}${ending}`
    const { fetchFn, seen } = sseFetch(body, 7, true)
    const response = await withToolArgumentLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
    expect(seen.cancelled).toBe(true)
  })

  it('preserves UTF-8 bytes split inside a character and JSON escapes split across events', async () => {
    const args = JSON.stringify({ text: '雨🌧️\\"[{}]'.repeat(100) })
    const { fetchFn } = sseFetch(`${argumentEvents(args, 3)}data: [DONE]\n\n`, 1)
    const response = await withToolArgumentLimit(fetchFn, 10_000)('https://gateway.test/v1/chat')
    expect(toolArguments(await response.text())).toEqual([args])
  })

  it('keeps interleaved calls separate, including custom tool input', async () => {
    let body = ''
    for (const piece of ['a', 'b', 'c'])
      body += event({
        tool_calls: [
          { index: 0, function: { arguments: piece } },
          { index: 1, custom: { input: piece.repeat(2) } },
        ],
      })
    const { fetchFn } = sseFetch(body, 7)
    const response = await withToolArgumentLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(toolArguments(await response.text())).toEqual(['abc', 'aabbcc'])
  })

  it('leaves HTTP errors available to the SDK error and overload handling', async () => {
    const body = '{"error":{"message":"overloaded"}}'
    const response = new Response(body, { status: 503 })
    const result = await withToolArgumentLimit(async () => response, 100)('https://gateway.test')
    expect(result).toBe(response)
    expect(await result.text()).toBe(body)
  })

  it('preserves complete arguments while coalescing their incomplete deltas', async () => {
    const body = `${argumentEvents('{"nodeIds":["a","b"]}', 4)}data: [DONE]\n\n`
    const { fetchFn } = sseFetch(body, 7)
    const response = await withToolArgumentLimit(fetchFn, 64)('https://gateway.test/v1/chat')
    const output = await response.text()
    expect(output).toContain('[DONE]')
    expect(toolArguments(output)).toEqual(['{"nodeIds":["a","b"]}'])
  })

  it('fails a runaway tool call and cancels the upstream stream', async () => {
    // 不收尾：失控的上游会一直吐下去，必须由这一层截断。
    const { fetchFn, seen } = sseFetch(argumentEvents('x'.repeat(5_000), 8), 300, true)
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
      `data: {"choices":[{"delta":{"content":"${'x'.repeat(AGENT_SSE_LINE_MAX_CHARS)}`,
      64 * 1024,
      true,
    )
    const response = await withToolArgumentLimit(fetchFn, 1_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
    expect(seen.cancelled).toBe(true)
  }, 2_000)

  it('fails an oversized line that arrives whole in one chunk', async () => {
    const line = `data: {"choices":[{"delta":{"content":"${'x'.repeat(AGENT_SSE_LINE_MAX_CHARS)}"}}]}\n\n`
    const { fetchFn } = sseFetch(line, line.length)
    const response = await withToolArgumentLimit(fetchFn, 1_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
  })

  it('passes a long text event on one line even when it exceeds the tool-argument limit', async () => {
    const body = event({ content: '雨'.repeat(10_000) })
    const { fetchFn } = sseFetch(body, 512)
    const response = await withToolArgumentLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })

  it('does not count streamed text toward the tool-argument limit', async () => {
    let body = ''
    for (let i = 0; i < 50; i++) body += event({ content: '雨夜旧车站'.repeat(10) })
    const { fetchFn } = sseFetch(body, 128)
    const response = await withToolArgumentLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })
})
