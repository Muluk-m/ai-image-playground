// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { resolveMediaSource } from '../../lib/cloudMedia'

vi.mock('../../lib/db', () => ({
  getCachedMedia: async () => undefined,
  pruneCachedMedia: async () => {},
  putCachedMedia: async () => {},
}))
vi.mock('../../lib/authClient', () => ({
  authenticatedBffFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

let id = 0
const source = () => `aip-media:${String(++id).padStart(8, '0')}-1111-4111-8111-111111111111`
beforeEach(() => setClientStorageScope('download-recovery'))
afterEach(() => {
  setClientStorageScope(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['access', 'status', 'body'])('recovers the real cloud original %s failure', async (stage) => {
  let access = 0
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) {
      access++
      if (stage === 'access' && access === 1) return Response.json({error: 'unavailable'}, {status: 503})
      return Response.json({originalUrl: 'https://storage.test/image', previewUrl: 'https://storage.test/preview'})
    }
    reads++
    if (stage === 'status' && reads === 1) return new Response('temporary', {status: 503})
    const response = new Response('pixels', {headers: {'content-type':'image/png'}})
    if (stage === 'body' && reads === 1) vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new TypeError('interrupted'))
    return response
  }))
  expect(await resolveMediaSource(source(), 'original', true)).toBe('data:image/png;base64,cGl4ZWxz')
  expect(access).toBe(2)
  expect(reads).toBe(stage === 'access' ? 1 : 2)
})

it('stops after one retry and allows a later explicit attempt to recover', async () => {
  const ref = source()
  let reads = 0
  let failing = true
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) return Response.json({originalUrl:'https://storage.test/image'})
    reads++
    return failing ? new Response('temporary', {status:503}) : new Response('pixels', {headers:{'content-type':'image/png'}})
  }))
  await expect(resolveMediaSource(ref, 'original', true)).rejects.toMatchObject({status:503})
  expect(reads).toBe(2)
  failing = false
  expect(await resolveMediaSource(ref, 'original', true)).toBe('data:image/png;base64,cGl4ZWxz')
  expect(reads).toBe(3)
})

it('does not retry a permanent HTTP rejection', async () => {
  const fetch = vi.fn(async () => Response.json({error:'not_found'}, {status:404}))
  vi.stubGlobal('fetch', fetch)
  await expect(resolveMediaSource(source(), 'original', true)).rejects.toMatchObject({status:404})
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('does not retry a body failure after the account changes', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) return Response.json({originalUrl:'https://storage.test/image'})
    reads++
    const response = new Response('partial')
    vi.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
      setClientStorageScope('different')
      throw new TypeError('interrupted')
    })
    return response
  }))
  await expect(resolveMediaSource(source(), 'original', true)).rejects.toThrow('media_scope_changed')
  expect(reads).toBe(1)
})
