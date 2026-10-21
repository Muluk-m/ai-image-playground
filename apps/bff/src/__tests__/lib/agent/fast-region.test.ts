import { describe, expect, it } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'

// mask-proposal 会读配置；这里只测纯函数，给够启动配置即可，不连数据库。
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused'
process.env.UPSTREAM_BASE_URL ??= 'http://gateway.test'
process.env.UPSTREAM_API_KEY ??= 'fixture-upstream-key'
const { raceRegionProposal, proposesRegion } = await import('../../../lib/agent/fast-region')
const { toolCallStream } = await import('../../../lib/agent/confirmed-edit')
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')

const MODEL = { api: 'openai-completions' as const, provider: 'gateway', id: 'm' }

function textStream(text: string, signal?: AbortSignal, delayMs = 0) {
  const stream = createAssistantMessageEventStream()
  const message = (stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
    role: 'assistant',
    content: stopReason === 'aborted' ? [] : [{ type: 'text', text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  })
  setTimeout(() => {
    if (signal?.aborted) {
      const aborted = message('aborted')
      stream.push({ type: 'error', reason: 'aborted', error: aborted })
      stream.end(aborted)
      return
    }
    const done = message('stop')
    stream.push({ type: 'start', partial: done })
    stream.push({ type: 'done', reason: 'stop', message: done })
    stream.end(done)
  }, delayMs)
  return stream
}

const propose = () => toolCallStream(MODEL, 'proposeEditRegion', { imageId: 'a', target: '浴缸' })

describe('fast tier region race', () => {
  it('uses the fast answer when it proposes a region and aborts the configured tier', async () => {
    let mainSignal: AbortSignal | undefined
    const losers: string[] = []
    const raced = await raceRegionProposal({
      fast: async () => propose(),
      main: async (signal) => {
        mainSignal = signal
        return textStream('slow', signal, 30)
      },
      onLoser: async (loser, message) => {
        losers.push(`${loser}:${message.stopReason}`)
      },
    })
    expect(raced.winner).toBe('fast')
    const message = await raced.stream.result()
    expect(proposesRegion(message)).toBe(true)
    const events = []
    for await (const event of raced.stream) events.push(event.type)
    expect(events).toEqual(['start', 'toolcall_start', 'toolcall_end', 'done'])
    expect(mainSignal?.aborted).toBe(true)
    await new Promise((done) => setTimeout(done, 60))
    expect(losers).toEqual(['main:aborted'])
  })

  it('keeps the configured tier when the fast answer is not a region proposal', async () => {
    const losers: string[] = []
    let mainSignal: AbortSignal | undefined
    const raced = await raceRegionProposal({
      fast: async () => textStream('直接改整张图'),
      main: async (signal) => {
        mainSignal = signal
        return toolCallStream(MODEL, 'editImage', { imageIds: ['a'] })
      },
      onLoser: async (loser) => {
        losers.push(loser)
      },
    })
    expect(raced.winner).toBe('main')
    expect((await raced.stream.result()).content[0]).toMatchObject({ name: 'editImage' })
    expect(mainSignal?.aborted).toBe(false)
    expect(losers).toEqual(['fast'])
  })

  it('keeps the configured tier when the fast call fails', async () => {
    const raced = await raceRegionProposal({
      fast: async () => {
        throw new Error('fast tier unavailable')
      },
      main: async () => textStream('好'),
    })
    expect(raced.winner).toBe('main')
    expect((await raced.stream.result()).stopReason).toBe('stop')
  })

  it('only counts a message that does nothing but propose a region', () => {
    return toolCallStream(MODEL, 'editImage', {})
      .result()
      .then((message) => expect(proposesRegion(message)).toBe(false))
  })
})
