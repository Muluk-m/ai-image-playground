// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { filesToReferences } from '../../../../features/agent/lib/attachments'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

const prepare = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/imagePreprocessing', () => ({
  IMAGE_PREPROCESSING: { maxPixels: 4194304 },
  preprocessImageFile: prepare,
}))

it('prepares every selected file before inline transport and uses the actual encoded MIME', async () => {
  prepare.mockResolvedValue({
    data: new Uint8Array([255, 216, 255, 217]).buffer,
    contentType: 'image/jpeg',
    width: 2048,
    height: 1843,
    originalBytes: 1200000,
  })
  const file = new File([new Uint8Array(300000)], 'original.png', { type: 'image/png' })
  const [reference] = await filesToReferences([file])
  expect(prepare).toHaveBeenCalledWith(file)
  expect(reference).toMatchObject({ name: 'original', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' })
})

it('persists prepared bytes and recovery metadata before cloud upload instead of the input original', async () => {
  setClientStorageScope('prepared-file-test')
  vi.stubGlobal('fetch', async () =>
    Response.json({
      'agent:attachments': true,
      'agent:bulk-attachments': true,
      attachmentLimits: {
        logicalReferences: 100,
        imageBytes: 20,
        imagePixels: 1000000000,
        uploadConcurrency: 4,
      },
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  const data = new Uint8Array([255, 216, 255, 217]).buffer
  prepare.mockResolvedValue({
    data,
    contentType: 'image/jpeg',
    width: 2048,
    height: 1843,
    originalBytes: 1200000,
  })
  const file = new File([new Uint8Array(1200000)], 'original.png', { type: 'image/png' })
  const [reference] = await filesToReferences([file])
  const { readLocalAttachment } = await import('../../../../lib/localAttachmentSources')
  const stored = await readLocalAttachment(reference!.dataUrl)
  expect(stored.data).toEqual(data)
  expect(stored.contentType).toBe('image/jpeg')
  expect(stored.preparation).toEqual({ originalBytes: 1200000, width: 2048, height: 1843 })
})

it('rejects the entire selected group when one file cannot be read', async () => {
  prepare.mockImplementation(async (file: File) => {
    if (file.name === 'bad.png') throw new Error('attachment_read_failed')
    return { data: new Uint8Array([1]).buffer, contentType: 'image/png' }
  })
  await expect(
    filesToReferences([new File([], 'good.png'), new File([], 'bad.png')]),
  ).rejects.toThrow('attachment_read_failed')
})
