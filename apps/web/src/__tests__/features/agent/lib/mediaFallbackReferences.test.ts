// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { IMAGE_DATA_URL_MAX_CHARS } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentRequestError } from '../../../../features/agent/lib/agentClient'
import { attachmentUploadErrorMessage } from '../../../../features/agent/lib/attachmentUploadErrors'
import {
  attachmentUploadError,
  attachmentUploadState,
  dataUrlBytes,
  mediaFallbackEnabled,
  prepareAttachmentReferences,
  REFERENCE_TOO_LARGE,
  referenceImageLimit,
  referenceSourceTooLarge,
} from '../../../../features/agent/lib/attachmentUploads'
import { describeSendFailure } from '../../../../features/agent/lib/sendFailure'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities, getMediaLimits } from '../../../../lib/clientCapabilities'
import { MediaRequestError } from '../../../../lib/cloudMedia'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

const PNG = [137, 80, 78, 71, 13, 10, 26, 10]
/** 一张字节数为 `bytes` 的「PNG」data URL：签名对得上，余下补零。 */
function pngDataUrl(bytes: number): string {
  const body = new Uint8Array(bytes)
  body.set(PNG)
  return `data:image/png;base64,${Buffer.from(body).toString('base64')}`
}
const ORIGINAL_ID = '11111111-2222-4333-8444-555555555555'
const MEDIA_LIMIT = 3_500_000

let descriptors: Record<string, unknown>[] = []
async function boot(manifest: Record<string, unknown>) {
  // jsdom 的 Response 给出的 ArrayBuffer 不是 Node 那一侧的，webcrypto 认不出；摘要前拷一份。
  vi.stubGlobal('crypto', {
    randomUUID: () => webcrypto.randomUUID(),
    getRandomValues: (array: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(array),
    subtle: {
      digest: (algorithm: string, data: ArrayBuffer) =>
        webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(data))),
    },
  })
  setClientStorageScope('media-fallback-test')
  descriptors = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/capabilities')) return Response.json(manifest)
      if (input.startsWith('data:image/'))
        return new Response(
          Uint8Array.from(atob(input.slice(input.indexOf(',') + 1)), (c) => c.charCodeAt(0)),
        )
      if (input.endsWith('/api/media/uploads')) {
        const descriptor = JSON.parse(String(init?.body)) as Record<string, unknown>
        descriptors.push(descriptor)
        const id = `media-${descriptors.length}`
        return Response.json({ id, status: 'pending', uploadUrl: `https://storage.test/${id}` })
      }
      if (input.startsWith('https://storage.test/')) return new Response(null, { status: 200 })
      if (input.endsWith('/complete')) {
        const id = input.split('/').slice(-2)[0]
        return Response.json({ id, status: 'ready' })
      }
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
}

const SYNCED = {
  'accounts:sync': true,
  'agent:attachments': false,
  mediaLimits: { imageBytes: MEDIA_LIMIT, imagePixels: 1_000_000_000 },
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('reads the ordinary media limit the server advertises, only with cloud sync on', async () => {
  await boot(SYNCED)
  expect(getMediaLimits()).toEqual({ imageBytes: MEDIA_LIMIT, imagePixels: 1_000_000_000 })
  expect(mediaFallbackEnabled()).toBe(true)
  expect(referenceImageLimit()).toEqual({ imageBytes: MEDIA_LIMIT, byId: true })
  await boot({ ...SYNCED, 'accounts:sync': false })
  expect(getMediaLimits()).toBeUndefined()
  expect(mediaFallbackEnabled()).toBe(false)
  expect(referenceImageLimit().byId).toBe(false)
})

it('uploads an image too long to inline as ordinary media and sends it by id, unscaled', async () => {
  await boot(SYNCED)
  const small = pngDataUrl(1000)
  const large = pngDataUrl(3_100_000)
  expect(large.length).toBeGreaterThan(IMAGE_DATA_URL_MAX_CHARS)
  const prepared = await prepareAttachmentReferences([
    { imageId: 'small', dataUrl: small },
    { imageId: 'large', dataUrl: large },
  ])
  expect(prepared).toEqual([
    { imageId: 'small', dataUrl: small },
    { imageId: 'large', mediaId: 'media-1' },
  ])
  // 普通云媒体：不带对话附件的用途；字节就是原件，没有缩小或重编码。
  expect(descriptors).toEqual([
    expect.objectContaining({ bytes: 3_100_000, contentType: 'image/png' }),
  ])
  expect(descriptors[0]).not.toHaveProperty('purpose')
})

it('a confirmed mask on an original already in the cloud uploads only the mask', async () => {
  await boot(SYNCED)
  const mask = pngDataUrl(2000)
  const [prepared] = await prepareAttachmentReferences([
    {
      imageId: 'photo',
      dataUrl: `aip-media:${ORIGINAL_ID}`,
      maskDataUrl: mask,
      editAction: 'inpaint',
    },
  ])
  expect(prepared).toEqual({
    imageId: 'photo',
    mediaId: ORIGINAL_ID,
    maskMediaId: 'media-1',
    editAction: 'inpaint',
  })
  expect(descriptors).toHaveLength(1)
})

it('flags an image over the media limit at attach time and never uploads it', async () => {
  await boot(SYNCED)
  const huge = pngDataUrl(MEDIA_LIMIT + 1)
  expect(dataUrlBytes(huge)).toBe(MEDIA_LIMIT + 1)
  expect(referenceSourceTooLarge(huge)).toBe(true)
  expect(referenceSourceTooLarge(pngDataUrl(MEDIA_LIMIT))).toBe(false)
  const reference = { dataUrl: huge }
  expect(attachmentUploadState(reference)).toBe('failed')
  expect(attachmentUploadError(reference)).toBe(REFERENCE_TOO_LARGE)
  expect(attachmentUploadErrorMessage(REFERENCE_TOO_LARGE)).toBe(
    '图片超过 3.3 MB，请换一张更小的图。',
  )
  await expect(
    prepareAttachmentReferences([{ imageId: 'huge', dataUrl: huge }]),
  ).rejects.toMatchObject({ code: 'media_too_large' })
  expect(descriptors).toHaveLength(0)
})

it('without cloud sync the request-body limit is the only limit', async () => {
  await boot({ 'accounts:sync': false })
  const large = pngDataUrl(3_100_000)
  expect(referenceSourceTooLarge(large)).toBe(true)
  expect(referenceSourceTooLarge(pngDataUrl(2_000_000))).toBe(false)
})

it('turns rejected sends into a reason and a next step', () => {
  const schema = new AgentRequestError(
    400,
    'invalid_request',
    undefined,
    '/references/0/dataUrl: Expected string length less or equal to 4000000',
  )
  expect(describeSendFailure(schema)).toMatchObject({ retryable: false })
  expect(describeSendFailure(schema)?.message).toContain('图片太大')
  expect(describeSendFailure(new MediaRequestError(413, 'media_too_large'))?.message).toContain(
    '图片太大',
  )
  expect(describeSendFailure(new AgentRequestError(400, 'invalid_request'))).toMatchObject({
    retryable: false,
  })
  expect(describeSendFailure(new AgentRequestError(503, 'upstream'))).toMatchObject({
    retryable: true,
  })
  expect(describeSendFailure(new TypeError('Failed to fetch'))).toMatchObject({ retryable: true })
  expect(describeSendFailure(new Error('other'))).toBeUndefined()
})
