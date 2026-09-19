// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { CURRENT_THUMBNAIL_VERSION, putImage, putImageThumbnail } from '../../lib/db'
import { isMediaRef, loadImageOriginal, loadImagePreview } from '../../lib/imageSource'

const THUMB = 'data:image/webp;base64,dGh1bWI='
const ORIGINAL = 'data:image/png;base64,b3JpZw=='

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  // 缩略图补图是 store 的后台活儿，这里只测读；空实现让它排上队但永不执行。
  vi.stubGlobal('requestIdleCallback', vi.fn())
  setClientStorageScope(crypto.randomUUID())
})

afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('本机 id 读本机缩略图与原图，一次网络都不发', async () => {
  const id = `local-${crypto.randomUUID()}`
  await putImage({ id, dataUrl: ORIGINAL, createdAt: 1 })
  await putImageThumbnail({
    id,
    thumbnailDataUrl: THUMB,
    width: 1024,
    height: 1536,
    thumbnailVersion: CURRENT_THUMBNAIL_VERSION,
  })
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)

  expect(isMediaRef(id)).toBe(false)
  expect(await loadImagePreview(id)).toEqual({ url: THUMB, width: 1024, height: 1536 })
  expect(await loadImageOriginal(id)).toBe(ORIGINAL)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('aip-media 引用按变体取云媒体：预览走 preview，要像素走 original', async () => {
  const ref = `aip-media:${crypto.randomUUID()}`
  const fetched: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      if (url.endsWith('/access')) {
        return Response.json({
          originalUrl: 'https://media.example/original',
          previewUrl: 'https://media.example/preview',
          expiresAt: Date.now() + 600_000,
        })
      }
      const bytes = url.endsWith('/preview') ? [1, 2, 3] : [4, 5, 6]
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/webp' } })
    }),
  )

  expect(isMediaRef(ref)).toBe(true)
  // 云媒体只给临时 URL，宽高得等 <img> 解码，这里就是 undefined。
  expect(await loadImagePreview(ref)).toEqual({ url: 'data:image/webp;base64,AQID' })
  expect(await loadImageOriginal(ref)).toBe('data:image/webp;base64,BAUG')
  expect(fetched).toContain('https://media.example/preview')
  expect(fetched).toContain('https://media.example/original')
})

it('读不到就返回 null，不抛给调用方', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 500 })),
  )

  const missingLocal = `local-${crypto.randomUUID()}`
  expect(await loadImagePreview(missingLocal)).toBeNull()
  expect(await loadImageOriginal(missingLocal)).toBeNull()

  const missingRemote = `aip-media:${crypto.randomUUID()}`
  expect(await loadImagePreview(missingRemote)).toBeNull()
  expect(await loadImageOriginal(missingRemote)).toBeNull()
})
