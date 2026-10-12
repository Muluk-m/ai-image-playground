// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  clearConversationCache,
  conversationCache,
} from '../../../features/agent/lib/conversationCache'
import { cachedPanel } from '../../../features/agent/lib/conversationCachePanel'
import type { AgentPanelState } from '../../../features/agent/lib/panelMessages'
import { setClientStorageScope } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const panel: AgentPanelState = {
  messages: [
    {
      kind: 'text',
      id: 'assistant',
      turnId: 'turn',
      role: 'assistant',
      text: '本地回复',
      streaming: false,
    },
  ],
  turns: {},
}

it.each([
  { messages: [null], turns: {} },
  { messages: [{ kind: 'text', id: 'one', turnId: 'turn', role: 'assistant' }], turns: {} },
  {
    messages: [
      { kind: 'clarification', id: 'one', turnId: 'turn', question: 'Question', options: [{}] },
    ],
    turns: {},
  },
  { messages: [{ ...panel.messages[0], references: [null] }], turns: {} },
  { ...panel, turns: { turn: null } },
  { ...panel, turns: [] },
])('rejects malformed cached messages and turn containers: %j', (value) => {
  expect(cachedPanel(value)).toBeNull()
})

it('projects only safe display fields from nested cached data', () => {
  expect(
    cachedPanel({
      messages: [
        {
          kind: 'tool',
          id: 'tool',
          turnId: 'turn',
          toolCallId: 'call',
          title: '可读摘要',
          status: 'succeeded',
          prompt: '保留提示词',
          saveCard: { views: null },
          artifacts: [null],
          job: { media: {} },
        },
        {
          ...panel.messages[0],
          references: [{ imageId: 'ref', mediaId: 'media', name: '原图', regions: [null] }],
        },
      ],
      turns: { turn: { turnId: 'turn', durationMs: 1234, cost: { chat: {}, image: 2, video: 0 } } },
    }),
  ).toEqual({
    messages: [
      {
        kind: 'tool',
        id: 'tool',
        turnId: 'turn',
        toolCallId: 'call',
        title: '可读摘要',
        status: 'succeeded',
        prompt: '保留提示词',
      },
      { ...panel.messages[0], references: [{ imageId: 'ref', mediaId: 'media', name: '原图' }] },
    ],
    turns: { turn: { turnId: 'turn', durationMs: 1234 } },
  })
})
beforeEach(() => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://one.test' } })
})

it('persists a conversation across cache handles and removes deleted history', async () => {
  await conversationCache('one').write(panel)
  expect(await conversationCache('one').read()).toEqual(panel)
  await conversationCache('one').remove()
  expect(await conversationCache('one').read()).toBeNull()
})

it('retains the displayed final cost without restoring executable job state', async () => {
  await conversationCache('cost').write({
    messages: [
      {
        kind: 'tool',
        id: 'tool',
        turnId: 'turn',
        toolCallId: 'call',
        title: '结果',
        status: 'succeeded',
        job: { taskId: 'task', media: 'image', chargedCredits: 100 },
      },
    ],
    turns: {
      turn: {
        turnId: 'turn',
        stopReason: 'completed',
        cost: { chat: 0, image: 0, video: 0, chatWaived: 20, includedTaskIds: [] },
      },
    },
  })
  const cached = await conversationCache('cost').read()
  expect(cached?.turns.turn?.cost).toEqual({ chat: 0, image: 100, video: 0, chatWaived: 20 })
  expect(cached?.messages[0]).not.toHaveProperty('job')
})

it('isolates accounts and API backends, including callbacks after a scope change', async () => {
  const first = conversationCache('one')
  await first.write(panel)
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://two.test' } })
  expect(await conversationCache('one').read()).toBeNull()
  expect(await first.read()).toBeNull()
  await first.write({ messages: [], turns: {} })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://one.test' } })
  expect(await first.read()).toEqual(panel)
  setClientStorageScope('another-account')
  expect(await conversationCache('one').read()).toBeNull()
  expect(await first.read()).toBeNull()
})

it('falls back to the server when storage transactions fail', async () => {
  await conversationCache('prime').write(panel)
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
    throw new Error('storage denied')
  })
  try {
    expect(await conversationCache('prime').read()).toBeNull()
    await expect(conversationCache('prime').write(panel)).resolves.toBeUndefined()
  } finally {
    transaction.mockRestore()
  }
})

it('evicts old snapshots instead of accumulating every conversation forever', async () => {
  for (let index = 0; index < 52; index++) await conversationCache(`bounded-${index}`).write(panel)
  expect(await conversationCache('bounded-0').read()).toBeNull()
  expect(await conversationCache('bounded-51').read()).toEqual(panel)
})

it('clears all backends of the logged-out account and prevents late writes', async () => {
  const user = crypto.randomUUID()
  setClientStorageScope(user)
  const first = conversationCache('one')
  await first.write(panel)
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://two.test' } })
  await conversationCache('one').write(panel)
  setClientStorageScope('keep-other-account')
  const other = conversationCache('one')
  await other.write(panel)
  setClientStorageScope(user)
  await clearConversationCache()
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open('image-playground-agent-history')
    request.onsuccess = () => resolve(request.result)
  })
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    const request = db.transaction('conversations').objectStore('conversations').getAllKeys()
    request.onsuccess = () => resolve(request.result)
  })
  expect(keys.some((key) => String(key).includes(user))).toBe(false)
  await first.write(panel)
  expect(await conversationCache('one').read()).toBeNull()
  setClientStorageScope('keep-other-account')
  expect(await other.read()).toEqual(panel)
  db.close()
})
