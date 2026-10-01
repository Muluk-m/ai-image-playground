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
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('blocks send after a failed attachment, exposes retry, and waits for verified readiness', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope('composer-attachment-test')
  const source = 'data:image/png;base64,iVBORw0KGgo='
  let fail = true
  let confirmed!: () => void
  const confirmation = new Promise<void>((resolve) => {
    confirmed = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/capabilities')) return Response.json({ 'agent:attachments': true })
      if (input === source) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
      if (input.endsWith('/api/media/uploads'))
        return Response.json({
          id: 'one',
          status: 'pending',
          uploadUrl: 'https://storage.test/one',
          leaseExpiresAt: Date.now() + 1200_000,
        })
      if (input === 'https://storage.test/one')
        return new Response(null, { status: fail ? 503 : 200 })
      if (input.endsWith('/complete')) {
        await confirmation
        return Response.json({ id: 'one', status: 'ready' })
      }
      return Response.json([])
    }),
  )
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update({ prompt: 'inspect this', references: [{ id: 'attachment', dataUrl: source }] })
  const send = vi.fn(async () => {})
  useAgentStore.setState({
    conversationId: null,
    historyLoading: false,
    historyFailed: false,
    turn: 'idle',
    send,
  })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(<AgentComposer doc={new CanvasDoc()} />)
    })
    const button = host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!
    expect(button.disabled).toBe(true)
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.textContent?.includes('重试'),
    )
    expect(retry).toBeDefined()
    fail = false
    await act(async () => {
      retry!.click()
    })
    expect(button.disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
    await act(async () => {
      confirmed()
      await confirmation
    })
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    await act(async () => {
      button.click()
    })
    expect(send).toHaveBeenCalledOnce()
  } finally {
    confirmed()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})
