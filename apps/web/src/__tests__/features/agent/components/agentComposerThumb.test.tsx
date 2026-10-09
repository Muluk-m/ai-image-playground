// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import * as mediaDb from '../../../../lib/db'
import { getCachedMedia, putCachedMedia } from '../../../../lib/db'
import { readAttachmentUpload } from '../../../../lib/localAttachmentSources'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

it.each([
  'success',
  'cached preview',
  'resolve failure',
  'decode failure',
  'cache deletion failure',
])('keeps the preview covered and recovers without re-uploading: %s', async (scenario) => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const original = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 1))}`
  let releasePreview!: () => void
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve
  })
  const previewBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
  let releaseUpload!: () => void
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  const thumbnail = vi
    .spyOn(mediaDb, 'createImageThumbnail')
    .mockRejectedValue(new Error('no local preview'))
  if (scenario === 'cached preview')
    thumbnail.mockResolvedValue({
      thumbnailDataUrl: `data:image/webp;base64,${previewBase64}`,
      width: 1,
      height: 1,
      thumbnailVersion: 1,
    })
  let uploads = 0
  let previews = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      uploads++
      if (scenario === 'cached preview') await uploadGate
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    if (url.endsWith('/access'))
      return Response.json({
        originalUrl: 'https://storage.test/original.png',
        previewUrl: 'https://storage.test/preview.png',
        expiresAt: Date.now() + 60_000,
      })
    if (url === 'https://storage.test/preview.png') {
      previews++
      await previewGate
      if (scenario === 'resolve failure' && previews === 1)
        return new Response('preview unavailable', { status: 503 })
      const data =
        (scenario === 'decode failure' || scenario === 'cache deletion failure') && previews === 1
          ? Uint8Array.from([1, 2, 3])
          : Uint8Array.from(atob(previewBase64), (char) => char.charCodeAt(0))
      return new Response(data, {
        headers: { 'content-type': 'image/png' },
      })
    }
    return Response.json([])
  })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: true })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  useAgentStore.setState({
    conversationId: null,
    historyLoading: false,
    historyFailed: false,
    turn: 'idle',
  })
  const session = agentDraft(null)
  await session.ready
  session.update({
    prompt: '看这张',
    references: [{ id: 'shot', name: '微信图片_202610', dataUrl: original }],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentComposer doc={new CanvasDoc()} />))
    if (scenario === 'cached preview') {
      await act(async () => {
        await vi.waitFor(() =>
          expect(host.querySelector('img')?.getAttribute('src')).toBe(
            `data:image/webp;base64,${previewBase64}`,
          ),
        )
        host.querySelector('img')!.dispatchEvent(new Event('load'))
      })
      expect(host.querySelector('img')?.className).not.toContain('opacity-0')
      expect(host.querySelector('[data-slot="attachment-loading"]')).toBeNull()
      expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
        true,
      )
      releaseUpload()
    }
    const send = () => host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!
    await act(async () => {
      await vi.waitFor(() => {
        expect(session.getSnapshot().draft.references[0]?.dataUrl).toMatch(/^aip-local:/)
        expect(send().disabled).toBe(false)
      })
    })
    const thumb = () => host.querySelector('img')!
    // Upload is ready, but the preview bytes are still withheld. An empty src paints the broken icon.
    if (scenario !== 'cached preview') {
      expect(thumb().getAttribute('src')).toBeNull()
      expect(thumb().className).toContain('opacity-0')
      expect(host.querySelector('[data-slot="attachment-loading"]')).not.toBeNull()
    }

    if (scenario === 'cached preview') {
      expect(thumb().getAttribute('src')).toBe(`data:image/webp;base64,${previewBase64}`)
      expect(thumb().className).not.toContain('opacity-0')
      expect(previews).toBe(0)
      expect(uploads).toBe(1)
      return
    }
    releasePreview()
    const retry = () => host.querySelector<HTMLButtonElement>('button[aria-label*="重试载入"]')!
    if (scenario === 'resolve failure') {
      await act(async () => {
        await vi.waitFor(() => expect(retry()).not.toBeNull())
      })
      expect(host.querySelector('[data-slot="attachment-loading"]')).toBeNull()
      expect(thumb().getAttribute('src')).toBeNull()
      await act(async () => retry().click())
    }
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(thumb().getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    })
    if (scenario !== 'cached preview') expect(thumb().className).toContain('opacity-0')
    if (scenario === 'decode failure' || scenario === 'cache deletion failure') {
      expect(thumb().getAttribute('src')).toBe('data:image/png;base64,AQID')
      const upload = await readAttachmentUpload(
        session.getSnapshot().draft.references[0]!.dataUrl,
        'http://bff.test',
      )
      if (upload?.state !== 'ready') throw new Error('expected ready attachment')
      const mediaId = upload.result.id
      const originalBytes = Uint8Array.from([9, 8, 7]).buffer
      await putCachedMedia({
        id: `${mediaId}:original`,
        data: originalBytes,
        contentType: 'image/png',
        bytes: 3,
        lastUsedAt: Date.now(),
      })
      await act(async () => thumb().dispatchEvent(new Event('error')))
      expect(retry()).not.toBeNull()
      expect(host.querySelector('[data-slot="attachment-loading"]')).toBeNull()
      if (scenario === 'cache deletion failure')
        vi.spyOn(mediaDb, 'dbTransaction').mockRejectedValueOnce(new Error('storage unavailable'))
      await act(async () => retry().click())
      await vi.waitFor(async () => {
        await act(async () => {})
        expect(thumb().getAttribute('src')).toBe(`data:image/png;base64,${previewBase64}`)
      })
      expect((await getCachedMedia(`${mediaId}:preview`))?.bytes).toBe(68)
      expect((await getCachedMedia(`${mediaId}:original`))?.data).toEqual(originalBytes)
    }
    await act(async () => {
      thumb().dispatchEvent(new Event('load'))
    })
    expect(thumb().className).not.toContain('opacity-0')
    expect(host.querySelector('[data-slot="attachment-loading"]')).toBeNull()
    expect(retry()).toBeNull()
    expect(uploads).toBe(1)
    expect(previews).toBe(['success', 'cached preview'].includes(scenario) ? 1 : 2)
  } finally {
    releasePreview()
    releaseUpload()
    session.update({ prompt: '', references: [] })
    await session.flush()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})
