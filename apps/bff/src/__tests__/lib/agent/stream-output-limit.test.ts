import { describe, expect, it } from 'bun:test'
import {
  AgentOutputRepetitionError,
  REPETITION_WINDOW_CHARS,
  RepetitionDetector,
  smallestPeriod,
  withOutputLimit,
} from '../../../lib/agent/stream-output-limit'
import { AgentToolArgumentsTooLargeError } from '../../../lib/agent/stream-tool-arguments'

const encoder = new TextEncoder()

const event = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta, finish_reason }] })}\n\n`

/** 每一段都不同的长文本，模拟真实的长回复。 */
const varied = (length: number) => {
  let text = ''
  for (let i = 0; text.length < length; i++) text += `第${i}镜：雨夜站台，林雨抬头。`
  return text.slice(0, length)
}

/** 按固定块长推送 SSE 文本；`hang` 时推完不收尾，模拟仍在吐字的上游。 */
function sseFetch(body: string, chunkSize: number, hang = false, status = 200) {
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
      { status, headers: { 'content-type': 'text/event-stream' } },
    )
  return { fetchFn, seen }
}

const deltas = (text: string, step: number, field = 'content') => {
  let body = ''
  for (let i = 0; i < text.length; i += step) body += event({ [field]: text.slice(i, i + step) })
  return body
}

describe('smallestPeriod', () => {
  it('finds the shortest repeating unit', () => {
    expect(smallestPeriod('abcabcabc')).toBe(3)
    expect(smallestPeriod('aaaa')).toBe(1)
    expect(smallestPeriod('abcd')).toBe(4)
    expect(smallestPeriod('')).toBe(0)
    // 周期不必整除长度：KMP 的边界只要求 s[i] === s[i + p]。
    expect(smallestPeriod('abcabcab')).toBe(3)
  })
})

describe('RepetitionDetector', () => {
  const feed = (text: string) => {
    const detector = new RepetitionDetector()
    for (let i = 0; i < text.length; i += 7) {
      const period = detector.push(text.slice(i, i + 7))
      if (period) return period
    }
    return 0
  }

  it('flags a short phrase looping past the window', () => {
    expect(feed('林雨捡起蓝色小册子。'.repeat(1_000))).toBe(10)
    expect(feed(`{"specs":${'['.repeat(10_000)}`)).toBe(1)
    // 4096 不是 3 的倍数，窗口起点落在单元中间也照样识别。
    expect(feed('xyz'.repeat(3_000))).toBe(3)
  })

  it('leaves long varied output alone', () => {
    expect(feed(varied(200_000))).toBe(0)
  })

  it('ignores loops shorter than the window', () => {
    expect(feed('ab'.repeat(REPETITION_WINDOW_CHARS / 2 - 1))).toBe(0)
  })
})

describe('model output limit', () => {
  it('passes complete events through unchanged while within budget', async () => {
    const body = `${deltas('你好，世界', 2)}${event({}, 'stop')}data: [DONE]\n\n`
    const { fetchFn } = sseFetch(body, 5)
    const response = await withOutputLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })

  it('ends an over-budget stream with a length stop and cancels the upstream', async () => {
    // 预算 100 token，宽限 1.25 倍；中文约 0.8 token/字，200 字远超。
    const { fetchFn, seen } = sseFetch(deltas(varied(400), 4), 64, true)
    const response = await withOutputLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    const text = await response.text()
    expect(text).toEndWith(`${event({}, 'length')}data: [DONE]\n\n`)
    // 只转发完整事件：每一段都是 data 行加空行。
    for (const block of text.trim().split('\n\n')) expect(block.startsWith('data: ')).toBe(true)
    expect(seen.cancelled).toBe(true)
  })

  it('counts tool-call arguments together with text', async () => {
    const half = varied(80)
    let body = deltas(half, 6)
    for (let i = 0; i < half.length; i += 6)
      body += event({ tool_calls: [{ index: 0, function: { arguments: half.slice(i, i + 6) } }] })
    const { fetchFn } = sseFetch(body, 32, true)
    const response = await withOutputLimit(fetchFn, 70)('https://gateway.test/v1/chat')
    expect(await response.text()).toContain('"finish_reason":"length"')
  })

  it('counts a reasoning delta duplicated across fields only once', async () => {
    let body = ''
    const text = varied(80)
    for (let i = 0; i < text.length; i += 4)
      body += event({ reasoning_content: text.slice(i, i + 4), reasoning: text.slice(i, i + 4) })
    body += 'data: [DONE]\n\n'
    const { fetchFn } = sseFetch(body, 64)
    // 80 字约 64 token；字段重复计两次就会越过 1.25 × 60 = 75。
    const response = await withOutputLimit(fetchFn, 60)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe(body)
  })

  it('fails a looping stream and cancels the upstream', async () => {
    const { fetchFn, seen } = sseFetch(deltas('林雨捡起蓝色小册子。'.repeat(1_000), 8), 256, true)
    const response = await withOutputLimit(fetchFn, 1_000_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentOutputRepetitionError)
    expect(seen.cancelled).toBe(true)
  })

  it('fails an oversized event instead of silently dropping it', async () => {
    const { fetchFn } = sseFetch(`${event({ content: 'x'.repeat(1_100_000) })}`, 64 * 1024)
    const response = await withOutputLimit(fetchFn, 10_000_000)('https://gateway.test/v1/chat')
    await expect(response.text()).rejects.toBeInstanceOf(AgentToolArgumentsTooLargeError)
  })

  it('drops entity headers that no longer describe the rewritten body', async () => {
    const body = `${event({ content: '好' })}data: [DONE]\n\n`
    const fetchFn = async () =>
      new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'content-length': String(body.length) },
      })
    const response = await withOutputLimit(fetchFn, 100)('https://gateway.test/v1/chat')
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe(body)
  })

  it('leaves error responses untouched', async () => {
    const { fetchFn } = sseFetch('{"error":"overloaded"}', 64, false, 503)
    const response = await withOutputLimit(fetchFn, 1)('https://gateway.test/v1/chat')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"overloaded"}')
  })
})
