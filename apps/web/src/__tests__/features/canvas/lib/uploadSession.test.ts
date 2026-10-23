// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  sessionStorage.clear()
  vi.resetModules()
})

const load = async () =>
  (await import('../../../../features/canvas/lib/uploadSession')).getCanvasUploaderId

it('keeps the tab uploader id across a reload of the same tab', async () => {
  const first = (await load())()
  expect(first).toMatch(/:[\w-]{8}$/)
  // 刷新页面：模块重新加载，sessionStorage 还在。
  vi.resetModules()
  expect((await load())()).toBe(first)
})

it('gives a new tab (fresh sessionStorage) a different uploader id on the same device', async () => {
  const first = (await load())()
  sessionStorage.clear()
  vi.resetModules()
  const second = (await load())()
  expect(second).not.toBe(first)
  expect(second.split(':')[0]).toBe(first.split(':')[0])
})
