import { describe, expect, it } from 'bun:test'
import { AgentStreamStalledError, withIdleTimeout } from '../../../lib/agent/stream-idle'

const encoder = new TextEncoder()

/** 按给定间隔吐出几块，然后要么收尾、要么一直挂着；记下它收到的中止信号。 */
function streamingFetch(chunks: readonly { afterMs: number; text: string }[], hang: boolean) {
  const seen: { signal?: AbortSignal } = {}
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.signal = init?.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await Bun.sleep(chunk.afterMs)
          controller.enqueue(encoder.encode(chunk.text))
        }
        if (!hang) controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetchFn, seen }
}

describe('model stream idle watchdog', () => {
  it('fails a stream that stops sending and aborts the upstream request', async () => {
    const { fetchFn, seen } = streamingFetch([{ afterMs: 0, text: 'data: a\n\n' }], true)
    const response = await withIdleTimeout(fetchFn, 40)('https://gateway.test/v1/chat')
    const started = performance.now()
    await expect(response.text()).rejects.toBeInstanceOf(AgentStreamStalledError)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(seen.signal?.aborted).toBe(true)
  })

  it('keeps a slow stream alive as long as each gap stays under the limit', async () => {
    const { fetchFn } = streamingFetch(
      [
        { afterMs: 25, text: 'data: a\n\n' },
        { afterMs: 25, text: 'data: b\n\n' },
        { afterMs: 25, text: 'data: c\n\n' },
      ],
      false,
    )
    const response = await withIdleTimeout(fetchFn, 60)('https://gateway.test/v1/chat')
    expect(await response.text()).toBe('data: a\n\ndata: b\n\ndata: c\n\n')
  })

  it('does not count the time the reader takes between reads', async () => {
    const { fetchFn, seen } = streamingFetch(
      [
        { afterMs: 0, text: 'data: a\n\n' },
        { afterMs: 0, text: 'data: b\n\n' },
      ],
      false,
    )
    const response = await withIdleTimeout(fetchFn, 40)('https://gateway.test/v1/chat')
    const reader = response.body!.getReader()
    await reader.read()
    await Bun.sleep(120)
    expect(seen.signal?.aborted).toBe(false)
    const rest = await reader.read()
    expect(new TextDecoder().decode(rest.value)).toBe('data: b\n\n')
  })

  it('fails a request whose response headers never arrive', async () => {
    let signal: AbortSignal | undefined
    const never = (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal?.reason)),
      )
    }
    await expect(withIdleTimeout(never, 40)('https://gateway.test/v1/chat')).rejects.toBeInstanceOf(
      AgentStreamStalledError,
    )
  })

  it('passes a caller abort through unchanged', async () => {
    const { fetchFn, seen } = streamingFetch([], true)
    const caller = new AbortController()
    const response = await withIdleTimeout(fetchFn, 5_000)('https://gateway.test/v1/chat', {
      signal: caller.signal,
    })
    caller.abort()
    expect(seen.signal?.aborted).toBe(true)
    await expect(response.text()).rejects.not.toBeInstanceOf(AgentStreamStalledError)
  })
})
