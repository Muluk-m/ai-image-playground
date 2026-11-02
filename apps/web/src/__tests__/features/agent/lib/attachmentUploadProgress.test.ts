// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  attachmentStackProgress,
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
  let confirm!: () => void
  const confirmed = new Promise<void>((resolve) => {
    confirm = resolve
  })
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
      if (input.endsWith('/complete')) {
        await confirmed
        return Response.json({ id: 'one', status: 'ready' })
      }
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
  // 全部交给网络栈不等于对端收到了：不报 100%，停在 99% 等服务端确认，百分比不收掉（BUG-42）。
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 8, total: 8 } as ProgressEvent)
  expect(attachmentUploadState(reference)).toBe('uploading')
  expect(attachmentUploadProgress(reference)).toBe(99)
  xhr.status = 200
  xhr.onload?.()
  await vi.waitFor(() => expect(attachmentUploadState(reference)).toBe('verifying'))
  expect(attachmentUploadProgress(reference)).toBe(99)
  confirm()
  expect(await prepared).toEqual([{ imageId: 'one', mediaId: 'one' }])
  expect(attachmentUploadState(reference)).toBe('ready')
  expect(attachmentUploadProgress(reference)).toBeUndefined()
})

it('收起那叠的总进度按字节加权，传完的那张按 100% 算，不往回跳（BUG-53）', async () => {
  vi.stubGlobal('crypto', webcrypto)
  FakeXhr.all = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  setClientStorageScope('attachment-stack-progress-test')
  const png = (size: number) => {
    const bytes = new Uint8Array(size)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    return bytes
  }
  const smallBytes = png(8)
  const bigBytes = png(24)
  const small = `data:image/png;base64,${Buffer.from(smallBytes).toString('base64')}`
  const big = `data:image/png;base64,${Buffer.from(bigBytes).toString('base64')}`
  let uploadsMade = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/capabilities'))
        return Response.json({ 'accounts:sync': true, 'agent:attachments': true })
      if (input === small) return new Response(smallBytes)
      if (input === big) return new Response(bigBytes)
      if (input.endsWith('/api/media/uploads')) {
        uploadsMade += 1
        return Response.json({
          id: `m${uploadsMade}`,
          status: 'pending',
          uploadUrl: `https://storage.test/m${uploadsMade}`,
          leaseExpiresAt: Date.now() + 1200_000,
        })
      }
      const done = /\/(m\d+)\/complete$/.exec(input)?.[1]
      if (done) return Response.json({ id: done, status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  const references = [{ dataUrl: small }, { dataUrl: big }]
  const batch = new Set([small, big])
  const prepared = prepareAttachmentReferences([
    { imageId: 'small', dataUrl: small },
    { imageId: 'big', dataUrl: big },
  ])
  await vi.waitFor(() => expect(FakeXhr.all.length).toBeGreaterThan(0))
  const first = FakeXhr.all[0]!
  first.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent)
  // 小图 8 字节、大图 24 字节：一张传一半时，按字节算是 12% 或 37%，不是两张平均的 25%。
  const halfway = attachmentStackProgress(references, batch)
  const sequential = FakeXhr.all.length === 1
  first.status = 200
  first.onload?.()
  await vi.waitFor(() =>
    expect(references.some((reference) => attachmentUploadState(reference) === 'ready')).toBe(true),
  )
  // 先传完的那张就是第一个请求对应的图。
  const firstIsSmall = attachmentUploadState({ dataUrl: small }) === 'ready'
  if (sequential) expect(halfway).toBe(firstIsSmall ? 12 : 37)
  await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(2))
  const second = FakeXhr.all[1]!
  second.upload.onprogress?.({ lengthComputable: true, loaded: 0, total: 2 } as ProgressEvent)
  // 传完的那张按 100% 留在总数里；旧算法只平均在传的那张，这里会掉回 0%。
  const afterOne = attachmentStackProgress(references, batch)
  expect(afterOne).toBe(firstIsSmall ? 25 : 75)
  expect(afterOne).toBeGreaterThanOrEqual(halfway ?? 0)
  // 不在这一批里的已就绪图是之前那批的，不算：只剩在传的那张。
  expect(attachmentStackProgress(references)).toBe(0)
  second.status = 200
  second.onload?.()
  await prepared
  expect(attachmentStackProgress(references, batch)).toBeUndefined()
})
