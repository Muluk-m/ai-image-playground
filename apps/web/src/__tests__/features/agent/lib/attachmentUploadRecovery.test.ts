// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({
  read: vi.fn<(source: string, backend: string) => Promise<unknown>>(),
  save: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  released: [] as ((release: { sources: readonly string[]; storageScope: string }) => void)[],
}))
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

const { attachmentUploadError, attachmentUploadState, primeAttachmentUploads } = await import(
  '../../../../features/agent/lib/attachmentUploads'
)
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
})
afterEach(() => {
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
