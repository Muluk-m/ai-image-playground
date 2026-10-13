// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  clearConversationCache,
  conversationCache,
} from '../../../features/agent/lib/conversationCache'
import { cachedPanel } from '../../../features/agent/lib/conversationCachePanel'
import type { AgentPanelState } from '../../../features/agent/lib/panelMessages'
import { setClientStorageScope } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

vi.mock('../../../features/agent/lib/conversationCachePolicy', () => ({ cacheMaxBytes: 65536 }))

async function cacheDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('image-playground-agent-history')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let migratedBytes = 0
let migratedKeys: IDBValidKey[] = []
beforeAll(async () => {
  const request = indexedDB.open('image-playground-agent-history', 1)
  await new Promise<void>((resolve) => {
    request.onupgradeneeded = () => {
      request.result.createObjectStore('conversations').createIndex('savedAt', 'savedAt')
    }
    request.onsuccess = () => resolve()
  })
  const tx = request.result.transaction('conversations', 'readwrite')
  tx.objectStore('conversations').put(
    { version: 1, savedAt: 100, panel },
    JSON.stringify(['image-playground-agent-history', 'https://one.test', 'legacy']),
  )
  for (let i = 0; i < 3; i++)
    tx.objectStore('conversations').put(
      { version: 1, savedAt: i, panel: sizedPanel(10000) },
      `legacy-large-${i}`,
    )
  tx.objectStore('conversations').put(null, 'corrupt-null')
  const circular: Record<string, unknown> = { version: 1, savedAt: 1, panel }
  circular.circular = circular
  tx.objectStore('conversations').put(circular, 'corrupt-cycle')
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve()
  })
  request.result.close()
  setClientStorageScope(null)
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://one.test' } })
  await conversationCache('legacy').read()
  const upgraded = await cacheDatabase()
  const usage = upgraded.transaction('usage').objectStore('usage').get('bytes')
  migratedBytes = await new Promise<number>((resolve) => {
    usage.onsuccess = () => resolve(usage.result)
  })
  const keys = upgraded.transaction('conversations').objectStore('conversations').getAllKeys()
  migratedKeys = await new Promise<IDBValidKey[]>((resolve) => {
    keys.onsuccess = () => resolve(keys.result)
  })
  upgraded.close()
})

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

it('keeps more than 50 conversations while their total size fits the budget', async () => {
  for (let index = 0; index < 52; index++) await conversationCache(`bounded-${index}`).write(panel)
  expect(await conversationCache('bounded-0').read()).toEqual(panel)
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

function sizedPanel(size: number): AgentPanelState {
  return {
    messages: [
      {
        kind: 'text',
        id: 'large',
        turnId: 'turn',
        role: 'assistant',
        text: '文'.repeat(size),
        streaming: false,
      },
    ],
    turns: {},
  }
}

it('upgrades existing snapshots without losing their display contents', async () => {
  setClientStorageScope(null)
  expect(await conversationCache('legacy').read()).toEqual(panel)
  expect(migratedBytes).toBeGreaterThan(60000)
  expect(migratedBytes).toBeLessThanOrEqual(65536)
  expect(migratedKeys).not.toContain('corrupt-null')
  expect(migratedKeys).not.toContain('corrupt-cycle')
  expect(migratedKeys).not.toContain('legacy-large-0')
})

it('evicts least recently read history by UTF-8 bytes, even without a successful server refresh', async () => {
  await clearConversationCache()
  setClientStorageScope(crypto.randomUUID())
  const clock = vi.spyOn(Date, 'now')
  try {
    clock.mockReturnValue(100)
    await conversationCache('old-revisited').write(sizedPanel(7000))
    clock.mockReturnValue(200)
    await conversationCache('unused').write(sizedPanel(7000))
    clock.mockReturnValue(300)
    expect(await conversationCache('old-revisited').read()).not.toBeNull()
    clock.mockReturnValue(400)
    await conversationCache('new').write(sizedPanel(10000))
    expect(await conversationCache('old-revisited').read()).not.toBeNull()
    expect(await conversationCache('unused').read()).toBeNull()
    expect(await conversationCache('new').read()).not.toBeNull()
  } finally {
    clock.mockRestore()
  }
})

it('replaces a snapshot without double counting its previous size', async () => {
  await conversationCache('keep').write(sizedPanel(7000))
  await conversationCache('replace').write(sizedPanel(7000))
  await conversationCache('replace').write(sizedPanel(8000))
  expect(await conversationCache('keep').read()).not.toBeNull()
  expect(await conversationCache('replace').read()).not.toBeNull()
})

it('skips oversized snapshots without evicting existing readable records', async () => {
  await conversationCache('keep').write(panel)
  await conversationCache('huge').write(sizedPanel(30000))
  expect(await conversationCache('huge').read()).toBeNull()
  expect(await conversationCache('keep').read()).toEqual(panel)
})

it('reclaims old history and retries once when the browser runs out of quota', async () => {
  await conversationCache('old').write(sizedPanel(1000))
  const put = IDBObjectStore.prototype.put
  let failures = 1
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === 'conversations' && failures-- > 0)
      throw new DOMException('Full', 'QuotaExceededError')
    return put.apply(this, args)
  })
  try {
    await conversationCache('new').write(panel)
    expect(await conversationCache('new').read()).toEqual(panel)
  } finally {
    spy.mockRestore()
  }
})

it('keeps the last snapshot readable if quota recovery also fails', async () => {
  await conversationCache('keep').write(panel)
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === 'conversations') throw new DOMException('Full', 'QuotaExceededError')
    return put.apply(this, args)
  })
  try {
    await conversationCache('keep').write(sizedPanel(1000))
    expect(await conversationCache('keep').read()).toEqual(panel)
  } finally {
    spy.mockRestore()
  }
})

it('serializes concurrent writes and keeps metadata consistent with snapshots', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => conversationCache(`parallel-${i}`).write(sizedPanel(5000))),
  )
  const db = await cacheDatabase()
  const tx = db.transaction(['conversations', 'metadata', 'usage'])
  const values = (store: string) =>
    new Promise<unknown[]>((resolve) => {
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result)
    })
  const [snapshots, metadata] = await Promise.all([values('conversations'), values('metadata')])
  const usage = tx.objectStore('usage').get('bytes')
  const total = await new Promise<number>((resolve) => {
    usage.onsuccess = () => resolve(usage.result)
  })
  expect(total).toBe(
    metadata.reduce<number>((sum, row) => sum + (row as { bytes: number }).bytes, 0),
  )
  expect(metadata.length).toBe(snapshots.length)
  expect(
    metadata.reduce<number>((sum, row) => sum + (row as { bytes: number }).bytes, 0),
  ).toBeLessThanOrEqual(65536)
  db.close()
})

it.each(['update', 'delete'])('does not let a quota retry undo a newer %s', async (action) => {
  const cache = conversationCache('race')
  await cache.write(panel)
  const put = IDBObjectStore.prototype.put
  let newer: Promise<void> | undefined
  let fail = true
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === 'conversations' && fail) {
      fail = false
      newer = action === 'update' ? cache.write(sizedPanel(1000)) : cache.remove()
      throw new DOMException('Full', 'QuotaExceededError')
    }
    return put.apply(this, args)
  })
  try {
    await cache.write(sizedPanel(2000))
    await newer
    expect(await cache.read()).toEqual(action === 'update' ? cachedPanel(sizedPanel(1000)) : null)
  } finally {
    spy.mockRestore()
  }
})

it('saves among many small conversations without scanning metadata until capacity is exceeded', async () => {
  const getAll = vi.spyOn(IDBIndex.prototype, 'getAll')
  const cursor = vi.spyOn(IDBIndex.prototype, 'openCursor')
  try {
    for (let i = 0; i < 200; i++) await conversationCache(`small-${i}`).write(panel)
    cursor.mockClear()
    await conversationCache('small-0').write(panel)
    expect(await conversationCache('small-0').read()).toEqual(panel)
    expect(getAll).not.toHaveBeenCalled()
    expect(cursor).not.toHaveBeenCalled()
  } finally {
    getAll.mockRestore()
    cursor.mockRestore()
  }
})

it('subtracts removed and logged-out records from the byte counter', async () => {
  const cache = conversationCache('remove-accounting')
  await cache.write(panel)
  await cache.remove()
  await conversationCache('logout-accounting').write(panel)
  await clearConversationCache()
  const db = await cacheDatabase()
  const tx = db.transaction(['metadata', 'usage'])
  const records = tx.objectStore('metadata').getAll()
  const count = tx.objectStore('usage').get('bytes')
  const [metadata, total] = await Promise.all([
    new Promise<{ bytes: number }[]>((resolve) => {
      records.onsuccess = () => resolve(records.result)
    }),
    new Promise<number>((resolve) => {
      count.onsuccess = () => resolve(count.result)
    }),
  ])
  expect(total).toBe(metadata.reduce((sum, record) => sum + record.bytes, 0))
  db.close()
})
