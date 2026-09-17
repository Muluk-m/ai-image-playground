// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import MediaImage from '../../components/MediaImage'
import { setClientStorageScope } from '../../lib/authScope'

afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})
it.each([
  '403',
  'cors',
])('缩略图只直读预览，签名过期 %s 自动重取，不把临时地址写成图片身份', async (failure) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope(crypto.randomUUID())
  const id = crypto.randomUUID()
  const fetched: string[] = []
  let access = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      if (url.endsWith('/access')) {
        access++
        return Response.json({
          originalUrl: 'https://media.example/original',
          previewUrl: `https://media.example/preview-${access}`,
          expiresAt: Date.now() + 600000,
        })
      }
      if (url.endsWith('preview-1')) {
        if (failure === 'cors') throw new TypeError('Failed to fetch')
        return new Response(null, { status: 403 })
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
    }),
  )
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MediaImage src={`aip-media:${id}`} alt="云端图片" />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,AQID')
    expect(fetched.filter((url) => url.endsWith('/access'))).toHaveLength(2)
    expect(fetched).not.toContain('https://media.example/original')
  } finally {
    act(() => root.unmount())
  }
})
