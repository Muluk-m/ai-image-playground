// @vitest-environment jsdom
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentPanelState } from '../../../../features/agent/lib/panelMessages'

const DATABASE = 'image-playground-agent-history'
const ACCOUNT = 'shared-cache-account'
const BACKEND = 'https://cache-concurrency.test'

let factory: IDBFactory
let connections: IDBDatabase[]
let requests: IDBOpenDBRequest[]

beforeEach(() => {
  factory = new IDBFactory()
  connections = []
  requests = []
  const open = factory.open.bind(factory)
  vi.spyOn(factory, 'open').mockImplementation((...args) => {
    const request = open(...args)
    requests.push(request)
    request.addEventListener('success', () => connections.push(request.result))
    return request
  })
  vi.stubGlobal('indexedDB', factory)
})

afterEach(() => {
  for (const connection of connections) connection.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function loadTab() {
  // Each tab owns its module-local mutation guards, but both tabs use the same browser DB.
  vi.resetModules()
  const { setClientStorageScope } = await import('../../../../lib/authScope')
  const { _setRuntimeConfigForTesting } = await import('../../../../lib/runtimeConfig')
  setClientStorageScope(ACCOUNT)
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: BACKEND } })
  return import('../../../../features/agent/lib/conversationCache')
}

function panel(text: string): AgentPanelState {
  return {
    messages: [
      {
        kind: 'text',
        id: 'assistant',
        turnId: 'turn',
        role: 'assistant',
        text,
        streaming: false,
      },
    ],
    turns: {},
  }
}

const races = (['sync-put', 'async-abort'] as const).flatMap((mode) =>
  (['update', 'delete', 'clear', 'delete-empty'] as const).map((action) => ({ mode, action })),
)

it.each(races)("does not let a $mode quota retry undo another tab's $action", async ({
  mode,
  action,
}) => {
  const firstTab = await loadTab()
  const first = firstTab.conversationCache('shared-conversation')
  if (action !== 'delete-empty') await first.write(panel('Original snapshot'))
  else await first.read()

  const secondTab = await loadTab()
  expect(secondTab.conversationCache).not.toBe(firstTab.conversationCache)
  const second = secondTab.conversationCache('shared-conversation')
  await second.read()

  const newerPanel = panel('Newer snapshot from the other tab')
  const put = IDBObjectStore.prototype.put
  let concurrentMutation: Promise<void> | undefined
  const mutateFromOtherTab = () => {
    concurrentMutation =
      action === 'update'
        ? second.write(newerPanel)
        : action === 'clear'
          ? secondTab.clearConversationCache()
          : second.remove()
  }
  let failOnce = true
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name !== 'conversations' || !failOnce) return put.apply(this, args)
    failOnce = false
    const error = new DOMException('Storage quota exhausted', 'QuotaExceededError')
    if (mode === 'sync-put') {
      // Queue the other tab's transaction before the failed save can retry.
      mutateFromOtherTab()
      throw error
    }
    const request = put.apply(this, args)
    const transaction = this.transaction
    request.addEventListener(
      'success',
      () => {
        mutateFromOtherTab()
        transaction.abort()
        // fake-indexeddb has no disk quota: fault-inject the browser's async abort cause.
        Object.defineProperty(transaction, 'error', { configurable: true, value: error })
      },
      { once: true },
    )
    return request
  })

  await first.write(panel('Stale snapshot awaiting quota recovery'))
  expect(concurrentMutation).toBeDefined()
  await concurrentMutation
  expect(await first.read()).toEqual(action === 'update' ? newerPanel : null)
})

function opened(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

async function holdLegacyConnection(): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('conversations').createIndex('savedAt', 'savedAt')
  }
  // The shipped v1 code had no versionchange listener; keep that connection open.
  return opened(request)
}

async function settlesPromptly(promise: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

it.each([
  'read',
  'remove',
  'clear',
] as const)('settles %s while an older tab blocks the cache upgrade', async (action) => {
  const legacy = await holdLegacyConnection()
  const tab = await loadTab()
  const cache = tab.conversationCache('blocked-conversation')
  const pending = action === 'clear' ? tab.clearConversationCache() : cache[action]()
  const upgrade = requests.at(-1)!
  const lateOpen = opened(upgrade)
  try {
    expect(await settlesPromptly(pending)).toBe(true)
  } finally {
    legacy.close()
    ;(await lateOpen).close()
    await pending.catch(() => {})
  }
})

it('closes an abandoned late open and can retry after the old tab releases its connection', async () => {
  const legacy = await holdLegacyConnection()
  const tab = await loadTab()
  const cache = tab.conversationCache('retry-after-upgrade')
  const pending = cache.read()
  const upgrade = requests.at(-1)!
  const lateOpen = opened(upgrade)
  try {
    expect(await settlesPromptly(pending)).toBe(true)
    legacy.close()
    const abandoned = await lateOpen
    expect(() => abandoned.transaction('conversations')).toThrow()

    const recovered = panel('Fresh cache after the blocked tab closes')
    await cache.write(recovered)
    expect(await cache.read()).toEqual(recovered)
  } finally {
    legacy.close()
    ;(await lateOpen).close()
    await pending.catch(() => {})
  }
})

it('preserves v2 snapshots and accounting while preventing old v2 writers from reopening', async () => {
  const request = factory.open(DATABASE, 2)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('conversations')
    request.result
      .createObjectStore('metadata', { keyPath: 'key' })
      .createIndex('accessedAt', 'accessedAt')
    request.result.createObjectStore('usage')
  }
  const legacy = await opened(request)
  const savedPanel = panel('Snapshot written by the v2 release')
  const record = { version: 1, savedAt: 100, panel: savedPanel }
  const key = JSON.stringify([`${DATABASE}:user-${ACCOUNT}`, BACKEND, 'legacy-v2'])
  const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength
  const transaction = legacy.transaction(['conversations', 'metadata', 'usage'], 'readwrite')
  transaction.objectStore('conversations').put(record, key)
  transaction.objectStore('metadata').put({ key, bytes, accessedAt: 100 })
  transaction.objectStore('usage').put(bytes, 'bytes')
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  // The shipped v2 connection closes on versionchange; its bundle still opens version 2.
  legacy.onversionchange = () => legacy.close()

  const tab = await loadTab()
  expect(await tab.conversationCache('legacy-v2').read()).toEqual(savedPanel)
  const upgraded = await opened(factory.open(DATABASE))
  expect(upgraded.version).toBe(3)
  const storedBytes = upgraded.transaction('usage').objectStore('usage').get('bytes')
  expect(
    await new Promise<number>((resolve, reject) => {
      storedBytes.onsuccess = () => resolve(storedBytes.result)
      storedBytes.onerror = () => reject(storedBytes.error)
    }),
  ).toBe(bytes)
  await expect(opened(factory.open(DATABASE, 2))).rejects.toMatchObject({ name: 'VersionError' })
})

it('settles repeated cache operations without queuing more opens while an old tab remains open', async () => {
  const legacy = await holdLegacyConnection()
  const tab = await loadTab()
  const cache = tab.conversationCache('blocked-operations')
  const pending = cache.read()
  const upgrade = requests.at(-1)!
  const lateOpen = opened(upgrade)
  const openedCount = requests.length
  try {
    expect(await settlesPromptly(pending)).toBe(true)
    for (const operation of [
      () => cache.read(),
      () => cache.write(panel('Cannot open the cache yet')),
      () => cache.remove(),
      () => tab.clearConversationCache(),
      () => cache.read(),
    ]) {
      expect(await settlesPromptly(operation())).toBe(true)
      expect(requests).toHaveLength(openedCount)
    }
  } finally {
    legacy.close()
    ;(await lateOpen).close()
    await pending.catch(() => {})
  }
})
