// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

/** 同一进程里模拟同源页面共用的 Web Locks：一个名字同一时刻只给一个持有者，排队的按顺序拿。 */
class FakeLocks {
  held = new Map<string, () => void>()
  waiting = new Map<string, (() => void)[]>()
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        let release = () => {}
        const done = new Promise<void>((r) => {
          release = r
        })
        this.held.set(name, release)
        void Promise.race([callback({ name }), done]).then((value) => {
          this.held.delete(name)
          this.waiting.get(name)?.shift()?.()
          resolve(value)
        })
      }
      if (!this.held.has(name)) return grant()
      if (options.ifAvailable) return void callback(null).then(resolve, reject)
      const queue = this.waiting.get(name) ?? []
      queue.push(grant)
      this.waiting.set(name, queue)
      options.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(grant)
        if (at < 0) return
        queue.splice(at, 1)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }
  /** 页面卸载：放掉它持有的锁。 */
  release(name: string) {
    this.held.get(name)?.()
  }
}

let locks: FakeLocks
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})
function withLocks() {
  locks = new FakeLocks()
  vi.stubGlobal('navigator', { ...navigator, locks })
}

const loadModule = () => import('../../../../features/canvas/lib/uploadSession')
/** 打开一个页面：重新加载模块（sessionStorage 由调用方决定是否保留），等后缀定下来。 */
async function openPage() {
  vi.resetModules()
  const page = await loadModule()
  await page.canvasUploaderSettled()
  return page
}
const suffix = (id: string) => id.slice(id.lastIndexOf(':') + 1)

it('keeps the tab uploader id across a reload of the same tab', async () => {
  withLocks()
  const first = (await openPage()).getCanvasUploaderId()
  expect(first).toMatch(/:[\w-]{8}$/)
  // 刷新：旧页面卸载、放掉锁，sessionStorage 还在。
  locks.release(`canvas-uploader-tab:${suffix(first)}`)
  expect((await openPage()).getCanvasUploaderId()).toBe(first)
})

it('keeps the id when the old page releases its lock shortly after the reload starts', async () => {
  withLocks()
  const first = (await openPage()).getCanvasUploaderId()
  setTimeout(() => locks.release(`canvas-uploader-tab:${suffix(first)}`), 200)
  expect((await openPage()).getCanvasUploaderId()).toBe(first)
})

it('gives a new tab (fresh sessionStorage) a different uploader id on the same device', async () => {
  withLocks()
  const first = (await openPage()).getCanvasUploaderId()
  sessionStorage.clear()
  const second = (await openPage()).getCanvasUploaderId()
  expect(second).not.toBe(first)
  expect(second.split(':')[0]).toBe(first.split(':')[0])
})

it('gives a duplicated tab a new id while the original keeps its own', async () => {
  withLocks()
  vi.useFakeTimers()
  vi.resetModules()
  const original = await loadModule()
  await original.canvasUploaderSettled()
  const before = original.getCanvasUploaderId()
  // 复制标签页：sessionStorage 一起复制，原页还开着、持有锁。
  vi.resetModules()
  const copy = await loadModule()
  let settled = false
  const done = copy.canvasUploaderSettled().then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(copy.CANVAS_UPLOADER_LOCK_WAIT_MS - 1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await done
  expect(copy.getCanvasUploaderId()).not.toBe(before)
  expect(original.getCanvasUploaderId()).toBe(before)
  // 新后缀也持有了锁，存回 sessionStorage，刷新复制页时沿用它。
  expect(locks.held.has(`canvas-uploader-tab:${suffix(copy.getCanvasUploaderId())}`)).toBe(true)
  expect(sessionStorage.getItem('canvas-uploader-tab')).toBe(suffix(copy.getCanvasUploaderId()))
})

it('never lets two pages settle on the same suffix even when both start together', async () => {
  withLocks()
  sessionStorage.setItem('canvas-uploader-tab', 'shared01')
  vi.useFakeTimers()
  vi.resetModules()
  const a = await loadModule()
  vi.resetModules()
  const b = await loadModule()
  const both = Promise.all([a.canvasUploaderSettled(), b.canvasUploaderSettled()])
  await vi.advanceTimersByTimeAsync(a.CANVAS_UPLOADER_LOCK_WAIT_MS)
  await both
  expect(a.getCanvasUploaderId()).not.toBe(b.getCanvasUploaderId())
  expect([a, b].filter((page) => page.getCanvasUploaderId().endsWith(':shared01'))).toHaveLength(1)
})

it('does not reuse a stored suffix when Web Locks are unavailable', async () => {
  vi.stubGlobal('navigator', { ...navigator, locks: undefined })
  sessionStorage.setItem('canvas-uploader-tab', 'copied01')
  const page = await openPage()
  expect(page.getCanvasUploaderId().endsWith(':copied01')).toBe(false)
})

it('does not call crypto.randomUUID when the module is only imported outside a page', async () => {
  vi.stubGlobal('window', undefined)
  const spy = vi.spyOn(crypto, 'randomUUID')
  try {
    vi.resetModules()
    await loadModule()
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
  }
})
