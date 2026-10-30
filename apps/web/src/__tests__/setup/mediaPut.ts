import { vi } from 'vitest'

/**
 * 直传 PUT 在浏览器里走 XHR 拿进度；jsdom 的 XHR 会真的发网络请求。
 * 其余用例都是 stub fetch 来模拟对象存储，这里让它们照旧走 fetch；
 * putMedia 本身的行为在 lib/mediaPut.test.ts 里用假 XHR 单测。
 */
vi.mock('../../lib/mediaPut', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/mediaPut')>()
  return {
    ...actual,
    putMedia: async (
      url: string,
      body: ArrayBuffer,
      contentType: string,
      options: { signal: AbortSignal },
    ) => {
      const sent = await fetch(url, {
        method: 'PUT',
        credentials: 'omit',
        signal: options.signal,
        headers: { 'content-type': contentType },
        body,
      })
      return { ok: sent.ok, status: sent.status }
    },
  }
})
