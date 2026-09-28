import { afterEach, expect, it, vi } from 'vitest'
import {
  trackConversationAdoption,
  waitForConversationAdoption,
} from '../../auth/conversationAdoption'

afterEach(() => {
  vi.useRealTimers()
  trackConversationAdoption(Promise.resolve())
})

it('慢认领最多挡历史读取 15 秒，迟到的成功仍能解除不确定状态', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  trackConversationAdoption(new Promise<void>((resolve) => (finish = resolve)))

  const waiting = waitForConversationAdoption()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await waiting).toBe(false)

  finish()
  await Promise.resolve()
  expect(await waitForConversationAdoption()).toBe(true)
})

it('认领请求失败时不把后续 404 当成已确认删除', async () => {
  trackConversationAdoption(Promise.reject(new Error('network error')))
  expect(await waitForConversationAdoption()).toBe(false)
})
