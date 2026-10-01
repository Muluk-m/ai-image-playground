import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView } from '@image-playground/shared'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = 'postgres://unused/model-history'
const { modelHistoryTransform, modelHistorySkillsMatch, readModelHistory, writeModelHistory } =
  await import('../../../lib/agent/model-history')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')

const product: AgentMessageView[] = [
  {
    id: 'user-1',
    turnId: 'turn-1',
    role: 'user',
    content: [{ type: 'text', text: '看看这张图' }],
    createdAt: 1,
  },
]
const identity = {
  conversationId: 'conversation-1',
  signature: 'model-and-authority-1',
  history: product,
}
const messages: AgentMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '当前时间：2026-10-01\n看看这张图' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ],
    timestamp: 1,
  },
  {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call-1', name: 'viewImage', arguments: { imageId: 'image-1' } },
    ],
    api: 'openai-completions',
    provider: 'upstream-gateway',
    model: 'test-model',
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'viewImage',
    content: [
      { type: 'text', text: '原图' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ],
    isError: false,
    timestamp: 3,
  },
]
let store: InMemoryObjectStore
beforeEach(() => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
})
afterEach(() => setObjectStoreForTesting())

describe('durable model history cache', () => {
  it('restores paired tools, exact timestamps and image bytes through the storage boundary', async () => {
    await writeModelHistory(identity, messages)
    expect(await readModelHistory(identity)).toEqual(messages)
    await writeModelHistory(identity, messages)
    expect(store.objects.size).toBe(1)
    await store.deletePrefix('agent/conversation-1/')
    expect(await readModelHistory(identity)).toBeUndefined()
  })

  it('rejects changed history, ownership/model signatures and malformed objects', async () => {
    await writeModelHistory(identity, messages)
    expect(
      await readModelHistory({ ...identity, signature: 'different-owner-or-model' }),
    ).toBeUndefined()
    expect(
      await readModelHistory({
        ...identity,
        history: [{ ...product[0]!, content: [{ type: 'text', text: 'edited' }] }],
      }),
    ).toBeUndefined()
    for (const object of store.objects.values()) object.bytes = new TextEncoder().encode('{')
    expect(await readModelHistory(identity)).toBeUndefined()
  })

  it('invalidates edited or deleted skill bodies even when the metadata is unchanged', async () => {
    const original = { ...identity, skillTexts: new Map([['skill-call', 'original file text']]) }
    await writeModelHistory(original, messages)
    expect(await readModelHistory(original)).toEqual(messages)
    expect(
      await readModelHistory({
        ...original,
        skillTexts: new Map([['skill-call', 'edited file text']]),
      }),
    ).toBeUndefined()
    expect(await readModelHistory({ ...original, skillTexts: new Map() })).toBeUndefined()
    expect(modelHistorySkillsMatch(messages, original.skillTexts, new Map())).toBe(false)
    expect(
      modelHistorySkillsMatch(
        [
          {
            role: 'toolResult',
            toolCallId: 'new-file',
            toolName: 'loadSkill',
            content: [{ type: 'text', text: 'file deleted during this turn' }],
            isError: false,
            timestamp: 4,
          },
        ],
        new Map(),
        new Map(),
      ),
    ).toBe(false)
  })

  it('falls back when valid JSON contains an image header that breaks token estimation', async () => {
    await writeModelHistory(identity, messages)
    const header = Buffer.alloc(16)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(header)
    for (const object of store.objects.values()) {
      const snapshot = JSON.parse(Buffer.from(object.bytes).toString())
      snapshot.messages[0].content[1].data = header.toString('base64')
      object.bytes = Buffer.from(JSON.stringify(snapshot))
    }
    expect(await readModelHistory(identity)).toBeUndefined()
  })

  it('cancels a stalled metadata request at the read deadline', async () => {
    let cancelled = false
    store.open = (_key, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(signal.reason)
          },
          { once: true },
        )
      })
    expect(await readModelHistory(identity)).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  it('bounds a hung write and rejects a late old snapshot after the conversation changes', async () => {
    const originalWrite = store.write.bind(store)
    let finish!: () => Promise<void>
    let signal: AbortSignal | undefined
    store.write = (key, bytes, contentType, abortSignal?: AbortSignal) => {
      signal = abortSignal
      return new Promise<void>((resolve) => {
        finish = async () => {
          await originalWrite(key, bytes, contentType)
          resolve()
        }
      })
    }
    await writeModelHistory(identity, messages)
    expect(signal?.aborted).toBe(true)
    await finish()
    expect(
      await readModelHistory({ ...identity, history: [{ ...product[0]!, id: 'next-user' }] }),
    ).toBeUndefined()
  }, 10_000)

  it('never restores unfinished calls or request-scoped selection bindings', async () => {
    await writeModelHistory(identity, messages.slice(0, 2))
    expect(await readModelHistory(identity)).toBeUndefined()
    await writeModelHistory(identity, [
      { role: 'user', content: 'selection_old_scope', timestamp: 0 },
      ...messages,
    ])
    expect(await readModelHistory(identity)).toBeUndefined()
  })

  it('rejects oversized objects before opening a response stream', async () => {
    let streamed = false
    store.open = async () => ({
      size: 9 * 1024 * 1024,
      stream: () => {
        streamed = true
        throw new Error('must not read')
      },
    })
    expect(await readModelHistory(identity)).toBeUndefined()
    expect(streamed).toBe(false)
  })

  it('falls back on unavailable storage without changing the caller outcome', async () => {
    store.writeFailuresRemaining = 1
    await expect(writeModelHistory(identity, messages)).resolves.toBeUndefined()
    expect(await readModelHistory(identity)).toBeUndefined()
  })

  it('keeps replacing the original native prefix on every call after budget fallback', async () => {
    const replay: AgentMessage[] = [{ role: 'user', content: '历史摘要', timestamp: 1 }]
    const current: AgentMessage = { role: 'user', content: '现在的问题', timestamp: 4 }
    const seen: AgentMessage[][] = []
    const transform = modelHistoryTransform({
      nativePrefixLength: messages.length,
      replay,
      settings: {
        contextWindow: 1_000,
        maxOutputTokens: 100,
        outputReserveTokens: 100,
        bufferTokens: 100,
        keepRecentTokens: 100,
        verbatimTokens: 100,
        failureThreshold: 3,
        breakerCooldownMs: 1_000,
      },
      overheadTokens: 0,
      compact: async (input) => {
        seen.push(input)
        return input
      },
    })
    const large: AgentMessage = { role: 'user', content: '新内容'.repeat(2_000), timestamp: 5 }
    await transform.transform([...messages, current, large])
    await transform.transform([...messages, current, large, current])
    expect(seen).toEqual([
      [...replay, current, large],
      [...replay, current, large, current],
    ])
    expect(transform.reusable()).toBe(false)
  })
})
