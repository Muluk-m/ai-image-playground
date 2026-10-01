// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareAttachmentReferences,
  retryAttachmentUpload,
} from '../../../../features/agent/lib/attachmentUploads'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('one failed upload prevents sending the whole snapshot; retry reuses successful originals', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope('attachment-test')
  const first = 'data:image/png;base64,iVBORw0KGgo='
  const second = 'data:image/png;base64,iVBORw0KGgoA'
  const references = [
    { imageId: 'first', dataUrl: first },
    { imageId: 'second', dataUrl: second },
  ]
  const uploads: string[] = []
  let failed = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/capabilities'))
        return Response.json({ 'accounts:sync': true, 'agent:attachments': true })
      if (input === first) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
      if (input === second)
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]))
      if (input.endsWith('/api/media/uploads')) {
        const descriptor = JSON.parse(String(init?.body))
        const id = descriptor.bytes === 8 ? 'one' : 'two'
        return Response.json({
          id,
          status: 'pending',
          uploadUrl: `https://storage.test/${id}`,
          leaseExpiresAt: Date.now() + 1200_000,
        })
      }
      if (input.startsWith('https://storage.test/')) {
        uploads.push(input)
        return new Response(null, { status: input.endsWith('two') && failed ? 503 : 200 })
      }
      if (input.endsWith('/complete'))
        return Response.json({ id: input.includes('/one/') ? 'one' : 'two', status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  await expect(prepareAttachmentReferences(references)).rejects.toThrow()
  failed = false
  await retryAttachmentUpload(second)
  expect(await prepareAttachmentReferences(references)).toEqual([
    { imageId: 'first', mediaId: 'one' },
    { imageId: 'second', mediaId: 'two' },
  ])
  expect(uploads.filter((url) => url.endsWith('one'))).toHaveLength(1)
  expect(uploads.filter((url) => url.endsWith('two'))).toHaveLength(2)
})
