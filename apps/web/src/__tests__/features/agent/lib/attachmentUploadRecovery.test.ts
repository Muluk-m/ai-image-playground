// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({
  read: vi.fn<(source: string, backend: string) => Promise<unknown>>(),
  save: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  released: [] as ((release: { sources: readonly string[]; storageScope: string }) => void)[],
}))
const remote = vi.hoisted(() => ({
  upload: vi.fn<(source: string, options: unknown) => Promise<unknown>>(),
}))
vi.mock('../../../../lib/mediaUpload', () => ({ uploadMediaSource: remote.upload }))
vi.mock('../../../../lib/localAttachmentSources', async (original) => ({
  ...(await original<typeof import('../../../../lib/localAttachmentSources')>()),
  readAttachmentUpload: local.read,
  saveAttachmentUpload: local.save,
  onLocalAttachmentReleased: (
    listener: (release: { sources: readonly string[]; storageScope: string }) => void,
  ) => {
    local.released.push(listener)
    return () => {}
  },
}))

const {
  attachmentUploadError,
  attachmentUploadState,
  primeAttachmentUploads,
  retryAttachmentUploads,
} = await import('../../../../features/agent/lib/attachmentUploads')
const { scopedStorageName, setClientStorageScope } = await import('../../../../lib/authScope')
const { bootstrapClientCapabilities } = await import('../../../../lib/clientCapabilities')
const { BASE_DB_NAME } = await import('../../../../lib/db')
const { loadRuntimeConfig } = await import('../../../../lib/runtimeConfig')

beforeEach(async () => {
  setClientStorageScope('attachment-recovery')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/capabilities'))
        return Response.json({ 'accounts:sync': true, 'agent:attachments': true })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  local.read.mockReset()
  local.save.mockReset()
  local.save.mockImplementation(async () => {})
  remote.upload.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('fails a reference whose local upload record never answers instead of queueing forever', async () => {
  vi.useFakeTimers()
  local.read.mockImplementation(() => new Promise(() => {}))
  local.save.mockImplementation(() => new Promise(() => {}))
  const reference = { dataUrl: 'data:image/png;base64,c3R1Y2s=' }
  const release = primeAttachmentUploads([reference])
  expect(attachmentUploadState(reference)).toBe('queued')
  // 读取、写回失败记录、再确认别的页面是否已传完，每一步都限时 30 秒。
  await vi.advanceTimersByTimeAsync(90_000)
  expect(attachmentUploadState(reference)).toBe('failed')
  expect(attachmentUploadError(reference)).toBe('media_timeout')
  release()
})

it('settles a still-shown reference after its cached entry is released', async () => {
  const reference = { dataUrl: 'data:image/png;base64,cmVsZWFzZWQ=' }
  local.read.mockResolvedValueOnce({
    state: 'ready',
    result: { id: 'media', sha256: 'hash', leaseExpiresAt: Date.now() + 3_600_000 },
  })
  const release = primeAttachmentUploads([reference])
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('ready'))
  local.read.mockResolvedValueOnce({ state: 'failed', errorCode: 'attachment_source_missing' })
  for (const listener of local.released)
    listener({ sources: [reference.dataUrl], storageScope: scopedStorageName(BASE_DB_NAME) })
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('failed'))
  expect(attachmentUploadError(reference)).toBe('attachment_source_missing')
  release()
})

// 长时间开着的标签页：上传租约过期后，参考图要重新确认，不能一直停在上传中。
it('re-uploads a draft reference whose saved lease has expired', async () => {
  const reference = { dataUrl: 'data:image/png;base64,ZXhwaXJlZA==' }
  local.read.mockResolvedValue({
    state: 'ready',
    result: { id: 'old', sha256: 'hash', leaseExpiresAt: Date.now() - 1_000 },
  })
  remote.upload.mockResolvedValue({
    id: 'fresh',
    sha256: 'hash',
    leaseExpiresAt: Date.now() + 3_600_000,
  })
  const release = primeAttachmentUploads([reference])
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('ready'))
  expect(remote.upload).toHaveBeenCalledOnce()
  release()
})

it('re-confirms a lease that expires while the tab stays open and recovers after a failed retry', async () => {
  const reference = { dataUrl: 'data:image/png;base64,bG9uZy1saXZlZA==' }
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  local.read.mockResolvedValue(undefined)
  remote.upload.mockResolvedValueOnce({
    id: 'first',
    sha256: 'hash',
    leaseExpiresAt: now + 3_600_000,
  })
  let release = primeAttachmentUploads([reference])
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('ready'))
  release()
  // 隔夜之后切回这个对话：内存里的租约已过期，网络恰好不通。
  now += 24 * 3_600_000
  remote.upload.mockRejectedValueOnce(new Error('media_network_error'))
  release = primeAttachmentUploads([reference])
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('failed'))
  expect(attachmentUploadError(reference)).toBe('media_network_error')
  remote.upload.mockResolvedValueOnce({
    id: 'second',
    sha256: 'hash',
    leaseExpiresAt: now + 3_600_000,
  })
  await retryAttachmentUploads(reference)
  expect(attachmentUploadState(reference)).toBe('ready')
  expect(remote.upload).toHaveBeenCalledTimes(3)
  release()
})
