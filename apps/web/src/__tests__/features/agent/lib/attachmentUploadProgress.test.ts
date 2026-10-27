// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  attachmentUploadProgress,
  attachmentUploadState,
  prepareAttachmentReferences,
} from '../../../../features/agent/lib/attachmentUploads'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

// 全局 setup 把直传换成了 fetch；这里要真的 XHR 进度。
vi.unmock('../../../../lib/mediaPut')

class FakeXhr {
  static all: FakeXhr[] = []
  status = 0
  withCredentials = true
  upload: { onprogress?: (event: ProgressEvent) => void } = {}
  onload?: () => void
  onabort?: () => void
  constructor() {
    FakeXhr.all.push(this)
  }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.onabort?.()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('exposes whole-percent direct-upload progress while the attachment is uploading', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  setClientStorageScope('attachment-progress-test')
  const source = 'data:image/png;base64,iVBORw0KGgo='
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/capabilities'))
        return Response.json({ 'accounts:sync': true, 'agent:attachments': true })
      if (input === source) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
      if (input.endsWith('/api/media/uploads'))
        return Response.json({
          id: 'one',
          status: 'pending',
          uploadUrl: 'https://storage.test/one',
          leaseExpiresAt: Date.now() + 1200_000,
        })
      if (input.endsWith('/complete')) return Response.json({ id: 'one', status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  const reference = { dataUrl: source }
  const prepared = prepareAttachmentReferences([{ imageId: 'one', dataUrl: source }])
  await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1))
  expect(attachmentUploadState(reference)).toBe('uploading')
  expect(attachmentUploadProgress(reference)).toBeUndefined()
  const xhr = FakeXhr.all[0]!
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 8 } as ProgressEvent)
  expect(attachmentUploadProgress(reference)).toBe(37)
  // 全部交给网络栈不等于对端收到了：不报 100%，退回「上传中」等响应（BUG-42）。
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 8, total: 8 } as ProgressEvent)
  expect(attachmentUploadState(reference)).toBe('uploading')
  expect(attachmentUploadProgress(reference)).toBeUndefined()
  xhr.status = 200
  xhr.onload?.()
  expect(await prepared).toEqual([{ imageId: 'one', mediaId: 'one' }])
  expect(attachmentUploadState(reference)).toBe('ready')
  expect(attachmentUploadProgress(reference)).toBeUndefined()
})
