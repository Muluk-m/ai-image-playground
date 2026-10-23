// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

/** 同一进程里模拟同源的多个页面：一个页面发的消息送到其余所有同名频道。 */
class FakeChannel {
  static open: FakeChannel[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor(readonly name: string) {
    FakeChannel.open.push(this)
  }
  postMessage(data: unknown) {
    for (const peer of FakeChannel.open)
      if (peer !== this && peer.name === this.name)
        queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent))
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((peer) => peer !== this)
  }
}

afterEach(() => {
  sessionStorage.clear()
  FakeChannel.open = []
  vi.unstubAllGlobals()
  vi.resetModules()
})

const load = async () =>
  (await import('../../../../features/canvas/lib/uploadSession')).getCanvasUploaderId
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

it('keeps the tab uploader id across a reload of the same tab', async () => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  const first = (await load())()
  expect(first).toMatch(/:[\w-]{8}$/)
  // 刷新页面：旧页面没了（频道关闭），模块重新加载，sessionStorage 还在。
  FakeChannel.open = []
  vi.resetModules()
  const reloaded = await load()
  await flush()
  expect(reloaded()).toBe(first)
})

it('gives a new tab (fresh sessionStorage) a different uploader id on the same device', async () => {
  const first = (await load())()
  sessionStorage.clear()
  vi.resetModules()
  const second = (await load())()
  expect(second).not.toBe(first)
  expect(second.split(':')[0]).toBe(first.split(':')[0])
})

it('gives a duplicated tab (copied sessionStorage) a new uploader id while the original keeps its own', async () => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  const original = await load()
  const before = original()
  await flush()
  // 复制标签页：sessionStorage 原样带过去，原页面还开着。
  vi.resetModules()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
  const duplicate = await load()
  await flush()
  await flush()
  expect(original()).toBe(before)
  expect(duplicate()).not.toBe(before)
  expect(duplicate().split(':')[0]).toBe(before.split(':')[0])
  // 复制页刷新后仍用它换来的新后缀。
  expect(sessionStorage.getItem('canvas-uploader-tab')).toBe(duplicate().split(':')[1])
})

it('switches both tabs off a shared id when they start in the same millisecond', async () => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  sessionStorage.setItem('canvas-uploader-tab', 'shared01')
  const first = await load()
  vi.resetModules()
  const second = await load()
  await flush()
  await flush()
  expect(first().endsWith(':shared01')).toBe(false)
  expect(second().endsWith(':shared01')).toBe(false)
  expect(first()).not.toBe(second())
})
