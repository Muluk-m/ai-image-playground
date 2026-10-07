// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

it('restores ready and failed local attachments after restart without uploading ready originals again', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const user = crypto.randomUUID()
  const uploads: string[] = []
  let failedId: string | undefined
  let retryAllowed = false
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
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body)) as { sha256: string }
      const id = `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`
      uploads.push(id)
      if (uploads.length === 3) failedId = id
      return Response.json({
        id,
        status: 'pending',
        uploadUrl: `https://storage.test/${id}`,
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    if (url.startsWith('https://storage.test/'))
      return new Response(null, {
        status: url.endsWith(failedId ?? '/never') && !retryAllowed ? 400 : 200,
      })
    if (url.endsWith('/complete'))
      return Response.json({ id: url.split('/').slice(-2)[0], status: 'ready' })
    return Response.json([])
  })
  const boot = async () => {
    const { setClientStorageScope } = await import('../../../../lib/authScope')
    setClientStorageScope(user)
    const { _setRuntimeConfigForTesting } = await import('../../../../lib/runtimeConfig')
    _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
    const { bootstrapClientCapabilities } = await import('../../../../lib/clientCapabilities')
    await bootstrapClientCapabilities(true, 'http://bff.test')
    const { useAgentStore } = await import('../../../../features/agent/store')
    useAgentStore.setState({
      conversationId: null,
      historyLoading: false,
      historyFailed: false,
      turn: 'idle',
    })
    const { useLibraryStore } = await import('../../../../features/library/store')
    useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
    const { useCanvasProjectStore } = await import('../../../../features/canvas/projectStore')
    useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: true })
    const { agentDraft } = await import('../../../../features/agent/lib/drafts')
    const session = agentDraft(null)
    await session.ready
    const { CanvasDoc } = await import('../../../../features/canvas/lib/canvasDoc')
    const { default: AgentComposer } = await import(
      '../../../../features/agent/components/AgentComposer'
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    return { session, host, root }
  }
  let mounted: Awaited<ReturnType<typeof boot>> | undefined
  try {
    mounted = await boot()
    const first = mounted
    await act(async () => {
      first.session.update({ prompt: '检查这些图片', references: [] })
      const input = first.host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: Array.from(
          { length: 3 },
          (_, index) =>
            new File(
              [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
              `reference-${index}.png`,
              { type: 'image/png' },
            ),
        ),
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(first.host.textContent).toContain('上传失败'))
    })
    const names = first.session.getSnapshot().draft.references.map((reference) => reference.name)
    await first.session.flush()
    act(() => first.root.unmount())
    first.host.remove()
    mounted = undefined
    vi.resetModules()
    mounted = await boot()
    const restored = mounted
    await act(async () => {
      restored.session.restoreUnsent()
      await vi.waitFor(() => expect(restored.host.textContent).toContain('上传失败'))
    })
    expect(
      restored.session.getSnapshot().draft.references.map((reference) => reference.name),
    ).toEqual(names)
    expect(uploads).toHaveLength(3)
    const send = restored.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!
    expect(send.disabled).toBe(true)
    retryAllowed = true
    await act(async () => {
      const retry = [...restored.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '重试',
      )!
      retry.click()
      await vi.waitFor(() => expect(send.disabled).toBe(false))
    })
    expect(uploads).toHaveLength(4)
    expect(uploads[3]).toBe(failedId)
  } finally {
    if (mounted) {
      act(() => mounted!.root.unmount())
      mounted.host.remove()
    }
    const { setClientStorageScope } = await import('../../../../lib/authScope')
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
}, 15_000)
