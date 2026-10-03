// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { prepareAttachmentReferences } from '../../../../features/agent/lib/attachmentUploads'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import {
  readLocalAttachment,
  registerLocalAttachmentSource,
} from '../../../../lib/localAttachmentSources'
import { uploadMediaSource } from '../../../../lib/mediaUpload'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

async function boot(fetcher: typeof fetch) {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', fetcher)
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  await bootstrapClientCapabilities(true, 'http://bff.test')
}
const manifest = {
  'agent:attachments': true,
  'agent:bulk-attachments': true,
  attachmentLimits: {
    logicalReferences: 100,
    imageBytes: 10 * 1024 * 1024,
    imagePixels: 40_000_000,
    uploadConcurrency: 1,
  },
}
afterEach(async () => {
  setClientStorageScope(null)
  await bootstrapClientCapabilities(false, '')
  vi.unstubAllGlobals()
})

it('honors the server upload concurrency of one across independent attachment uploads', async () => {
  let reservations = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  await boot(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities')) return Response.json(manifest)
    if (url.startsWith('data:'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      reservations++
      return Response.json({
        id: crypto.randomUUID(),
        status: 'pending',
        uploadUrl: 'https://storage.test/upload',
      })
    }
    if (init?.method === 'PUT') {
      await barrier
      return new Response(null, { status: 200 })
    }
    return Response.json({ id: url.split('/').slice(-2)[0], status: 'ready' })
  })
  const originals = [1, 2, 3].map((value) =>
    registerLocalAttachmentSource(
      `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, value))}`,
      1024,
    ),
  )
  await Promise.all(originals.map(readLocalAttachment))
  const uploading = Promise.all(
    originals.map((source) =>
      uploadMediaSource(source, {
        purpose: 'conversation-attachment',
        signal: new AbortController().signal,
      }),
    ),
  )
  void uploading.catch(() => {})
  try {
    await vi.waitFor(() => expect(reservations).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reservations).toBe(1)
  } finally {
    release()
    await uploading
  }
  expect(reservations).toBe(3)
})

it.each([
  'attachments',
  'bulk-disabled',
  'bulk-missing',
] as const)('keeps a restored local original but blocks sending when %s capability is disabled', async (disabled) => {
  let enabled = true
  const network: string[] = []
  await boot(async (input) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json(
        enabled
          ? manifest
          : {
              ...manifest,
              ...(disabled === 'attachments'
                ? { 'agent:attachments': false }
                : { 'agent:bulk-attachments': disabled === 'bulk-disabled' ? false : undefined }),
            },
      )
    if (url.startsWith('data:'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    network.push(url)
    return Response.json([])
  })
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
    prompt: 'keep this draft',
    references: [{ id: 'photo', dataUrl: `data:image/png;base64,${btoa('original')}` }],
  })
  await session.flush()
  const handle = session.getSnapshot().draft.references[0]!.dataUrl
  enabled = false
  await bootstrapClientCapabilities(true, 'http://bff.test')
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentComposer doc={new CanvasDoc()} />))
    expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
      true,
    )
    expect(host.textContent).toContain('附件上传当前不可用')
    await expect(
      prepareAttachmentReferences([{ imageId: 'photo', dataUrl: handle }]),
    ).rejects.toThrow('attachment_capability_unavailable')
    expect(new TextDecoder().decode((await readLocalAttachment(handle)).data)).toBe('original')
    expect(network.filter((url) => !url.includes('/api/agent/skills?'))).toEqual([])
  } finally {
    act(() => root.unmount())
    session.update({ prompt: '', references: [] })
    await session.flush()
  }
})
