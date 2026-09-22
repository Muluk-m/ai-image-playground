// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveMediaSource } from '../../lib/cloudMedia'

/**
 * 回源限流是全局两路。作品页一进来就在铺预览，用户这时点复用 / 编辑 / 看原图，
 * 那几张不能排在整页预览后面——2026-09-22 生产实测，刚加载完就点复用要等 21s。
 */
const id = (n: number) => `aip-media:${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`

let release: Array<() => void>
let holding: boolean
let accessed: string[]

beforeEach(() => {
  release = []
  holding = true
  accessed = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/access')) {
        accessed.push(String(url))
        // 取签名地址先挂住，制造「两路都占着、后面排队」的现场。
        if (holding) await new Promise<void>((resolve) => release.push(resolve))
        return Response.json({
          originalUrl: 'https://media.example/bytes',
          previewUrl: 'https://media.example/bytes',
          expiresAt: Date.now() + 60_000,
        })
      }
      return new Response(new Blob(['bytes'], { type: 'image/png' }))
    }),
  )
})

afterEach(async () => {
  holding = false
  for (const resume of release) resume()
  vi.unstubAllGlobals()
})

it('用户点出来的那张插在正在铺的预览之前', async () => {
  const background = [1, 2, 3, 4].map((n) => resolveMediaSource(id(n), 'preview'))
  await vi.waitFor(() => expect(accessed).toHaveLength(2))

  const urgent = resolveMediaSource(id(9), 'original', true)
  // 两路都占着，第三、四张背景预览还在队里；这时放行一路。
  release.shift()?.()

  await vi.waitFor(() => expect(accessed).toHaveLength(3))
  expect(accessed[2]).toContain('00000009')

  holding = false
  for (const resume of release) resume()
  await expect(urgent).resolves.toContain('data:')
  await Promise.all(background)
})
