// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import {
  localAttachmentPreview,
  registerLocalAttachmentSource,
} from '../../lib/localAttachmentSources'

const thumbnail = vi.hoisted(() =>
  vi.fn<(source: string) => Promise<{ thumbnailDataUrl: string }>>(),
)
vi.mock('../../lib/db', async (original) => ({
  ...(await original<object>()),
  createImageThumbnail: thumbnail,
}))

afterEach(() => {
  setClientStorageScope(null)
  thumbnail.mockReset()
  vi.unstubAllGlobals()
})

it('decodes local thumbnails one at a time and skips queued work after an account switch', async () => {
  setClientStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1])))
  const complete: ((value: { thumbnailDataUrl: string }) => void)[] = []
  thumbnail.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete.push(resolve)
      }),
  )
  const first = registerLocalAttachmentSource('data:image/png;base64,AQ==', 1024)
  const second = registerLocalAttachmentSource('data:image/png;base64,Ag==', 1024)
  const third = registerLocalAttachmentSource('data:image/png;base64,Aw==', 1024)
  const firstPreview = localAttachmentPreview(first)!
  const secondPreview = localAttachmentPreview(second)!
  const thirdPreview = localAttachmentPreview(third)!
  await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(1))
  complete[0]!({ thumbnailDataUrl: 'data:image/webp;base64,first' })
  await expect(firstPreview).resolves.toContain('first')
  await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(2))
  setClientStorageScope(crypto.randomUUID())
  expect(localAttachmentPreview(first)).toBeUndefined()
  complete[1]!({ thumbnailDataUrl: 'data:image/webp;base64,second' })
  await secondPreview
  await expect(thirdPreview).resolves.toBeUndefined()
  expect(thumbnail).toHaveBeenCalledTimes(2)
})
