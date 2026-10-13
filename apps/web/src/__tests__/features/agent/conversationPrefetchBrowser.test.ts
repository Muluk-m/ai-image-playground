// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserConversationPrefetch } from '../../../features/agent/lib/conversationPrefetch'
import { setClientStorageScope } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const { status, save, fetchMessages } = vi.hoisted(() => ({
  status: vi.fn(),
  save: vi.fn(),
  fetchMessages: vi.fn(),
}))
vi.mock('../../../features/agent/lib/conversationCache', () => ({
  conversationCache: () => ({ prefetchStatus: status, prefetch: save }),
}))
vi.mock('../../../features/agent/lib/agentClient', async (original) => ({
  ...(await original<typeof import('../../../features/agent/lib/agentClient')>()),
  fetchMessages,
}))
let worker: ReturnType<typeof browserConversationPrefetch> | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  setClientStorageScope('prefetch-browser')
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://example.test' } })
  status.mockResolvedValue('missing')
  save.mockResolvedValue('stored')
  fetchMessages.mockResolvedValue({ messages: [], turns: [], activeTurn: { turnId: 'active' } })
})
afterEach(() => {
  worker?.dispose()
  worker = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const catalog = [{ id: 'unopened', title: '', updatedAt: 1, createdAt: 1 }]
const tick = () => vi.advanceTimersByTimeAsync(3000)
it('caches an unopened active snapshot without opening or executing it', async () => {
  worker = browserConversationPrefetch()
  worker.update(catalog, false, null)
  await tick()
  expect(fetchMessages).toHaveBeenCalledWith('unopened', undefined, expect.any(AbortSignal))
  expect(save).toHaveBeenCalledWith({ messages: [], turns: {} }, expect.any(AbortSignal))
})
it('does not download an already cached history', async () => {
  status.mockResolvedValue('present')
  worker = browserConversationPrefetch()
  worker.update(catalog, false, null)
  await tick()
  expect(fetchMessages).not.toHaveBeenCalled()
})
it('passes foreground cancellation to the real fetch boundary and ignores a late response', async () => {
  let finish: (value: unknown) => void = () => {}
  fetchMessages.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  worker = browserConversationPrefetch()
  worker.update(catalog, false, null)
  await tick()
  const editor = document.createElement('input')
  document.body.append(editor)
  editor.addEventListener('keydown', (event) => event.stopPropagation())
  editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
  editor.remove()
  expect(fetchMessages.mock.calls[0][2].aborted).toBe(true)
  finish({ messages: [], turns: [], activeTurn: null })
  await Promise.resolve()
  expect(save).not.toHaveBeenCalled()
})
it('does not fetch after switching accounts while the metadata lookup was pending', async () => {
  let finish: (value: string) => void = () => {}
  status.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  worker = browserConversationPrefetch()
  worker.update(catalog, false, null)
  await tick()
  setClientStorageScope('other-account')
  finish('missing')
  await Promise.resolve()
  await Promise.resolve()
  expect(fetchMessages).not.toHaveBeenCalled()
})
