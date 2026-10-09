// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { invalidateMediaPreview, resolveMediaSource } from '../../lib/cloudMedia'
import * as mediaDb from '../../lib/db'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

it('keeps bypassing a bad disk preview across a failed retry, until its replacement is persisted', async () => {
  setClientStorageScope('preview-retry-storage-failure')
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const source = 'aip-media:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:preview'
  let requests = 0
  vi.stubGlobal('fetch', async (input: string | Request | URL) => {
    if (String(input).endsWith('/access'))
      return Response.json({
        originalUrl: 'https://storage.test/original.png',
        previewUrl: 'https://storage.test/preview.png',
        expiresAt: Date.now() + 60_000,
      })
    requests++
    return requests === 1
      ? new Response('offline', { status: 503 })
      : new Response(Uint8Array.from([4, 5, 6]), { headers: { 'content-type': 'image/png' } })
  })
  try {
    await mediaDb.putCachedMedia({
      id,
      data: Uint8Array.from([1, 2, 3]).buffer,
      contentType: 'image/png',
      bytes: 3,
      lastUsedAt: Date.now(),
    })
    expect(await resolveMediaSource(source, 'preview')).toBe('data:image/png;base64,AQID')
    vi.spyOn(mediaDb, 'dbTransaction').mockRejectedValueOnce(new Error('storage unavailable'))
    await invalidateMediaPreview(source)
    await expect(resolveMediaSource(source, 'preview')).rejects.toThrow('media_download_failed')
    // A new consumer mounts without clicking invalidate a second time. It must not read old bytes.
    expect(await resolveMediaSource(source, 'preview')).toBe('data:image/png;base64,BAUG')
    expect(requests).toBe(2)
    expect(new Uint8Array((await mediaDb.getCachedMedia(id))!.data)).toEqual(
      Uint8Array.from([4, 5, 6]),
    )
    expect(await resolveMediaSource(source, 'preview')).toBe('data:image/png;base64,BAUG')
    expect(requests).toBe(2)
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setClientStorageScope(null)
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  }
})
