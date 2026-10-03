// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentPromptDraft from '../../../features/agent/components/AgentPromptDraft'
import { useAgentStore } from '../../../features/agent/store'
import type { AgentToolMessage } from '../../../features/agent/types'
import ProductionGenerationPane from '../../../features/production/components/ProductionGenerationPane'
import ProductionGenerations from '../../../features/production/components/ProductionGenerations'
import { activateProduction } from '../../../features/production/lib/productionContext'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => request.mockReset())
const message: AgentToolMessage = {
  kind: 'tool',
  id: 'message',
  turnId: 'turn',
  toolCallId: 'call',
  title: '生成雨衣造型',
  prompt: '三视图',
  status: 'awaiting_confirmation',
  productionDraftRevision: 1,
  toolName: 'generateImage',
}
it('keeps production confirmation only in its authoritative target pane', async () => {
  useAgentStore.setState({ conversationId: 'conversation' })
  const open = vi.fn()
  const release = activateProduction('conversation', open)
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        generations: [
          {
            messageId: 'message',
            production: { documentId: 'doc', target: 'look', targetId: 'look-rain' },
          },
        ],
      }),
    ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentPromptDraft message={message} />))
    expect(host.querySelector('textarea')).toBeNull()
    const button = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === '查看生成草稿',
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(request.mock.calls[0][0]).toContain(
      '/conversation/production/generations?messageId=message',
    )
    expect(open).toHaveBeenCalledWith({
      documentId: 'doc',
      target: 'look',
      targetId: 'look-rain',
      messageId: 'message',
    })
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    )
  } finally {
    release()
    await act(async () => root.unmount())
    host.remove()
  }
})
it('does not navigate a late lookup into the newly selected conversation', async () => {
  useAgentStore.setState({ conversationId: 'old' })
  let resolve: (response: Response) => void = () => {}
  request.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done
      }),
  )
  const open = vi.fn()
  const release = activateProduction('new', open)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentPromptDraft message={message} />))
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '查看生成草稿')!
        .click(),
    )
    await act(async () => useAgentStore.setState({ conversationId: 'new' }))
    await act(async () =>
      resolve(
        new Response(
          JSON.stringify({
            generations: [
              {
                messageId: 'message',
                production: { documentId: 'doc', target: 'clip', targetId: 'clip' },
              },
            ],
          }),
        ),
      ),
    )
    expect(open).not.toHaveBeenCalled()
  } finally {
    release()
    await act(async () => root.unmount())
    host.remove()
  }
})

it('shows a deleted target error instead of falling back to another look', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerationPane
          document={{
            id: 'doc',
            conversationId: 'conversation',
            projectId: null,
            revision: 2,
            updatedAt: 1,
            content: {
              title: '片',
              setting: '',
              outline: '',
              scenes: [],
              characters: [
                {
                  id: 'lin',
                  name: '林',
                  description: '',
                  looks: [{ id: 'other', name: '另一造型', description: '' }],
                },
              ],
            },
          }}
          target={{ documentId: 'doc', target: 'look', targetId: 'deleted', messageId: 'message' }}
          onSaved={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('来源对象可能已删除')
    expect(host.textContent).not.toContain('另一造型')
    expect(request).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('focused draft review cannot create candidates that its exact lookup would hide', async () => {
  request.mockResolvedValue(Response.json({ generations: [] }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerations
          conversationId="conversation"
          document={{
            id: 'doc',
            conversationId: 'conversation',
            projectId: null,
            revision: 2,
            updatedAt: 1,
            content: { title: '片', setting: '', outline: '', scenes: [] },
          }}
          target={{ kind: 'look', id: 'look' }}
          focusMessageId="message"
          onSaved={() => {}}
        />,
      ),
    )
    expect(host.textContent).not.toContain('新候选')
    expect(request.mock.calls[0][0]).toContain('messageId=message')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
