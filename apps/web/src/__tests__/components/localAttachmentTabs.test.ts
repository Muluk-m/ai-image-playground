// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

/** Browser transport substitute: each imported module graph represents a separate page. */
class TestChannel extends EventTarget {
  static channels = new Set<TestChannel>()
  static muted = false
  readonly name: string
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor(name: string) {
    super()
    this.name = name
    TestChannel.channels.add(this)
  }
  postMessage(data: unknown) {
    if (TestChannel.muted) return
    for (const channel of TestChannel.channels) {
      if (channel === this || channel.name !== this.name) continue
      queueMicrotask(() => {
        if (!TestChannel.channels.has(channel)) return
        const event = new MessageEvent('message', { data: structuredClone(data) })
        channel.dispatchEvent(event)
        channel.onmessage?.(event)
      })
    }
  }
  close() {
    TestChannel.channels.delete(this)
  }
}

afterEach(() => {
  for (const channel of TestChannel.channels) channel.close()
  TestChannel.muted = false
  vi.unstubAllGlobals()
})

async function pages() {
  vi.resetModules()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('BroadcastChannel', TestChannel)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const user = crypto.randomUUID()
  const peerScope = await import('../../lib/authScope')
  peerScope.setClientStorageScope(user)
  const peer = await import('../../lib/localAttachmentSources')
  vi.resetModules()
  const scope = await import('../../lib/authScope')
  scope.setClientStorageScope(user)
  const local = await import('../../lib/localAttachmentSources')
  const uploads = await import('../../features/agent/lib/attachmentUploads')
  const runtime = await import('../../lib/runtimeConfig')
  runtime._setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const fetched: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    fetched.push(url)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 1048576,
          imagePixels: 40000000,
          uploadConcurrency: 4,
        },
      })
    if (url.endsWith('/access'))
      return Response.json({
        originalUrl: 'https://storage.test/original',
        previewUrl: 'https://storage.test/preview',
        expiresAt: Date.now() + 600000,
      })
    if (url === 'https://storage.test/preview')
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
    throw new Error(`Unexpected network ${url}`)
  })
  await (await import('../../lib/clientCapabilities')).bootstrapClientCapabilities(
    true,
    'http://bff.test',
  )
  const source = local.registerLocalAttachmentSource(
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'source.png', {
      type: 'image/png',
    }),
    1048576,
  )
  await local.readLocalAttachment(source)
  const result = {
    id: crypto.randomUUID(),
    sha256: '1'.repeat(64),
    leaseExpiresAt: Date.now() + 1200000,
  }
  return { peer, peerScope, local, uploads, source, result, fetched }
}

it('另一页较旧失败写入不能覆盖同原件同后端仍有效的 ready 租约', async () => {
  const { peer, local, source, result } = await pages()
  await local.saveAttachmentUpload(source, 'http://bff.test', { state: 'ready', result })
  await peer.saveAttachmentUpload(source, 'http://bff.test', {
    state: 'failed',
    errorCode: 'media_upload_failed',
  })
  expect(await local.readAttachmentUpload(source, 'http://bff.test')).toEqual({
    state: 'ready',
    result,
  })
  await peer.saveAttachmentUpload(source, 'http://other.test', {
    state: 'failed',
    errorCode: 'media_upload_failed',
  })
  expect(await local.readAttachmentUpload(source, 'http://other.test')).toEqual({
    state: 'failed',
    errorCode: 'media_upload_failed',
  })
})

it.each([
  'broadcast',
  'focus',
] as const)('跨页完成以 %s 刷新预览和已缓存失败，跨页释放撤掉旧预览', async (delivery) => {
  const { peer, local, uploads, source, result, fetched } = await pages()
  const owner = peer.attachmentSourceOwner('draft:cross-page')
  await owner.retain({ references: [{ dataUrl: source }] })
  await local.saveAttachmentUpload(source, 'http://bff.test', {
    state: 'failed',
    errorCode: 'media_upload_failed',
  })
  const references = [{ imageId: 'original', dataUrl: source }]
  await expect(uploads.prepareAttachmentReferences(references)).rejects.toThrow(
    'media_upload_failed',
  )
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: MediaImage } = await import('../../components/MediaImage')
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(MediaImage, { src: source, alt: '原图' })))
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
    TestChannel.muted = delivery === 'focus'
    await act(async () => {
      await peer.saveAttachmentUpload(source, 'http://bff.test', { state: 'ready', result })
      if (delivery === 'focus') window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,AQID')
    })
    expect(await uploads.prepareAttachmentReferences(references)).toEqual([
      { imageId: 'original', mediaId: result.id },
    ])
    expect(fetched.some((url) => url.endsWith('/uploads') || url.endsWith('/original'))).toBe(false)
    TestChannel.muted = false
    await act(async () => {
      await owner.release()
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
    })
    await expect(uploads.prepareAttachmentReferences(references)).rejects.toThrow(
      'attachment_source_missing',
    )
  } finally {
    act(() => root.unmount())
  }
})

async function holdUpload(result: { id: string; leaseExpiresAt: number }) {
  let entered = false
  let release = () => {}
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/uploads'))
      return Response.json({
        id: result.id,
        status: 'pending',
        uploadUrl: 'https://storage.test/pending',
      })
    if (url === 'https://storage.test/pending') {
      entered = true
      signal = init?.signal ?? undefined
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(new Response(null, { status: 200 }))
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    }
    if (url.endsWith('/complete'))
      return Response.json({
        id: result.id,
        status: 'ready',
        leaseExpiresAt: result.leaseExpiresAt,
      })
    throw new Error(`Unexpected network ${url}`)
  })
  return { entered: () => entered, aborted: () => signal?.aborted, release: () => release() }
}

it('跨页成功收敛到发送方已持有的进行中上传 Promise', async () => {
  const { peer, uploads, source, result } = await pages()
  const gate = await holdUpload(result)
  const sending = uploads.prepareAttachmentReferences([{ imageId: 'original', dataUrl: source }])
  const outcome = sending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  try {
    await vi.waitFor(() => expect(gate.entered()).toBe(true))
    await peer.saveAttachmentUpload(source, 'http://bff.test', { state: 'ready', result })
    await vi.waitFor(() => expect(uploads.attachmentUploadState({ dataUrl: source })).toBe('ready'))
    gate.release()
    expect(await outcome).toEqual({ value: [{ imageId: 'original', mediaId: result.id }] })
  } finally {
    gate.release()
    await outcome
  }
})

it('重试上传期间页面激活不会用旧持久失败中止新请求', async () => {
  const { local, uploads, source, result } = await pages()
  await local.saveAttachmentUpload(source, 'http://bff.test', {
    state: 'failed',
    errorCode: 'media_upload_failed',
  })
  await expect(
    uploads.prepareAttachmentReferences([{ imageId: 'original', dataUrl: source }]),
  ).rejects.toThrow('media_upload_failed')
  const gate = await holdUpload(result)
  const retried = uploads.retryAttachmentUpload(source)
  const outcome = retried.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  try {
    await vi.waitFor(() => expect(gate.entered()).toBe(true))
    window.dispatchEvent(new Event('focus'))
    await local.readAttachmentUpload(source, 'http://bff.test')
    expect(gate.aborted()).toBe(false)
    gate.release()
    expect(await outcome).toMatchObject({ value: { id: result.id } })
  } finally {
    gate.release()
    await outcome
  }
})
