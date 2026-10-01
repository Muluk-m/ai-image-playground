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
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { useStore } from '../../../../store'

it('shows only a cloud thumbnail and reads the original and mask only when opening their editor', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const original = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 1))}`
  const mask = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 2))}`
  const viewed: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
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
    if (url.startsWith('https://storage.test/')) {
      viewed.push(url)
      return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 3]), {
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
    prompt: '编辑局部',
    references: [
      { id: 'masked', name: '局部图', dataUrl: original, maskDataUrl: mask, editAction: 'inpaint' },
    ],
  })
  const originalHandle = session.getSnapshot().draft.references[0]!.dataUrl
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentComposer doc={new CanvasDoc()} />))
    await act(async () => {
      await vi.waitFor(() => expect(viewed).toEqual(['https://storage.test/preview.png']))
      await vi.waitFor(() =>
        expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/),
      )
    })
    expect(JSON.stringify(session.getSnapshot().draft)).not.toContain('base64,')
    expect(useStore.getState().maskEditorSession).toBeNull()
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="修改参考图 局部图 的遮罩"]')!
        .click()
      await vi.waitFor(() =>
        expect(useStore.getState().maskEditorSession?.targetDataUrl).toBe(original),
      )
    })
    const editor = useStore.getState().maskEditorSession!
    expect(editor.maskDataUrl).toBe(mask)
    expect(viewed).toEqual(['https://storage.test/preview.png'])
    await act(async () =>
      editor.onSave({ maskDataUrl: mask, targetDataUrl: original, targetImageId: 'masked' }),
    )
    expect(session.getSnapshot().draft.references[0]!.dataUrl).toBe(originalHandle)
  } finally {
    session.update({ prompt: '', references: [] })
    await session.flush()
    act(() => root.unmount())
    host.remove()
    useStore.setState({ maskEditorSession: null })
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})
