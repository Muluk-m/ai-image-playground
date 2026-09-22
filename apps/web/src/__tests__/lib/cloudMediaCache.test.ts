// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, type Mock, vi } from 'vitest'

/**
 * 云媒体的本机缓存。媒体身份不可变，所以命中就不回源——本机生成读 IndexedDB 是瞬时的，
 * 云端生成没有理由慢一个数量级（2026-09-22 生产实测：作品页刚加载完点复用要等 21.7s，
 * 期间 56 次取签名地址，全是这一页预览重新下的）。
 */
const ref = (n: number) => `aip-media:${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`

let fetcher: Mock

/**
 * 每次 import 都是一次新会话：内存热表随之清空，落盘的缓存留在同一个 IndexedDB 里。
 * 这里要的正是「重新加载模块」这个边界，静态 import 拿不到新的模块实例。
 */
async function newSession() {
  vi.resetModules()
  return await import('../../lib/cloudMedia')
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  fetcher = vi.fn(async (url: string) => {
    if (String(url).endsWith('/access'))
      return Response.json({
        originalUrl: 'https://media.example/original',
        previewUrl: 'https://media.example/preview',
        expiresAt: Date.now() + 60_000,
      })
    return new Response(new Blob(['pixels'], { type: 'image/png' }))
  })
  vi.stubGlobal('fetch', fetcher)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('刷新之后同一张图直接读本机，不再回源', async () => {
  const first = await newSession()
  const before = await first.resolveMediaSource(ref(1), 'preview')
  expect(fetcher).toHaveBeenCalled()

  fetcher.mockClear()
  const second = await newSession()
  const after = await second.resolveMediaSource(ref(1), 'preview')

  expect(after).toBe(before)
  expect(fetcher).not.toHaveBeenCalled()
})

it('原图和预览各存各的，取原图不会拿预览顶替', async () => {
  const media = await newSession()
  await media.resolveMediaSource(ref(2), 'preview')
  fetcher.mockClear()
  await media.resolveMediaSource(ref(2), 'original')

  expect(fetcher.mock.calls.map(([url]) => String(url))).toContain('https://media.example/original')
})

it('超出上限时先丢最久没用过的那张', async () => {
  const media = await newSession()
  media.setMediaDiskBudgetForTesting(12)
  await media.resolveMediaSource(ref(3), 'preview')
  await media.resolveMediaSource(ref(4), 'preview')

  // 新的一会话：热表是空的，只有还留在本机的那张能免于回源。
  const next = await newSession()
  next.setMediaDiskBudgetForTesting(12)
  fetcher.mockClear()
  await next.resolveMediaSource(ref(4), 'preview')
  expect(fetcher).not.toHaveBeenCalled()

  await next.resolveMediaSource(ref(3), 'preview')
  expect(fetcher).toHaveBeenCalled()
})
