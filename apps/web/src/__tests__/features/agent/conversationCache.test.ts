// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  clearConversationCache,
  conversationCache,
} from '../../../features/agent/lib/conversationCache'
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
