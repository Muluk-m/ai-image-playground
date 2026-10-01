// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionQuoteChip from '../../../features/production/components/ProductionQuoteChip'
import ProductionWorkspace from '../../../features/production/components/ProductionWorkspace'
import { productionTurnContext } from '../../../features/production/lib/productionContext'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  window.getSelection()?.removeAllRanges()
})
const documentFixture = {
  id: 'doc',
  conversationId: 'conversation',
  projectId: null,
  revision: 3,
  updatedAt: 1,
  content: {
    title: '雨夜来客',
    setting: '旧站台',
    outline: '重逢',
    scenes: [{ id: 'scene', title: '站台', body: '林夏收起雨伞。' }],
  },
}

it('quotes an actual text selection and keeps the frozen target when another section opens', async () => {
  request.mockImplementation(
    async () =>
      new Response(JSON.stringify({ document: documentFixture, history: [], proposals: [] })),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <ProductionQuoteChip conversationId="conversation" />
        </ProductionWorkspace>,
      ),
    )
    expect(host.querySelector('[aria-label="引用到对话"]')).toBeNull()
    const prose = host.querySelector('.production-scene p')!
    const range = document.createRange()
    range.setStart(prose.firstChild!, 2)
    range.setEnd(prose.firstChild!, 6)
    await act(async () => {
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="引用到对话"]')!.click(),
    )
    expect(host.textContent).toContain('收起雨伞')
    const frozen = productionTurnContext('conversation')
    expect(frozen).toMatchObject({
      production: {
        documentId: 'doc',
        revision: 3,
        target: 'scene',
        sceneId: 'scene',
        quote: { start: 2, end: 6, text: '收起雨伞' },
      },
    })
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '故事设定')!
        .click(),
    )
    expect(productionTurnContext('conversation')).toEqual(frozen)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click())
    expect(productionTurnContext('conversation')).not.toHaveProperty('production.quote')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('refreshes a new suggestion without a document revision change and adopts the compared text', async () => {
  let hasProposal = false
  let adopted = false
  request.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/adopt')) adopted = true
    return new Response(
      JSON.stringify({
        document: {
          ...documentFixture,
          revision: adopted ? 4 : 3,
          content: adopted
            ? {
                ...documentFixture.content,
                scenes: [{ id: 'scene', title: '站台', body: '林夏打开雨伞。' }],
              }
            : documentFixture.content,
        },
        history: [],
        proposals: hasProposal
          ? [
              {
                id: 'proposal',
                baseRevision: 3,
                target: 'scene',
                sceneId: 'scene',
                before: '林夏收起雨伞。',
                after: '林夏打开雨伞。',
                sourceTurnId: 'turn',
                status: adopted ? 'adopted' : 'pending',
                createdAt: 1,
              },
            ]
          : [],
      }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const render = (key: string) => (
      <ProductionWorkspace conversationId="conversation" refreshKey={key}>
        <span>聊天</span>
      </ProductionWorkspace>
    )
    await act(async () => root.render(render('before')))
    expect(host.textContent).not.toContain('采用修改')
    hasProposal = true
    await act(async () => root.render(render('tool-complete')))
    expect(host.textContent).toContain('林夏打开雨伞。')
    expect(host.textContent).toContain('林夏收起雨伞。')
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '采用修改')!
        .click(),
    )
    const call = request.mock.calls.find(([url]) => url.endsWith('/adopt'))!
    expect(JSON.parse(call[1].body)).toMatchObject({ baseRevision: 3 })
    expect(host.textContent).toContain('修订版 V4')
    expect(host.querySelector('.production-scene p')?.textContent).toBe('林夏打开雨伞。')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('keeps an outdated proposal separate and lets the author discard it without overwriting the new script', async () => {
  let discarded = false
  request.mockImplementation(async (url: string) => {
    if (url.endsWith('/discard')) discarded = true
    return new Response(
      JSON.stringify({
        document: { ...documentFixture, revision: 4 },
        history: [],
        proposals: discarded
          ? []
          : [
              {
                id: 'proposal',
                baseRevision: 3,
                target: 'scene',
                sceneId: 'scene',
                before: '旧正文',
                after: '建议正文',
                sourceTurnId: 'turn',
                status: 'pending',
                createdAt: 1,
              },
            ],
      }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <span>聊天</span>
        </ProductionWorkspace>,
      ),
    )
    const adopt = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === '采用修改',
    )!
    expect(adopt.disabled).toBe(true)
    expect(host.textContent).toContain('原文已有新版本')
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '放弃建议')!
        .click(),
    )
    expect(host.textContent).not.toContain('建议正文')
    expect(host.textContent).toContain('修订版 V4')
    expect(host.querySelector('.production-scene p')?.textContent).toBe('林夏收起雨伞。')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('dismisses the selection action with Escape and restores focus without creating a quote', async () => {
  request.mockImplementation(
    async () =>
      new Response(JSON.stringify({ document: documentFixture, history: [], proposals: [] })),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="escape-conversation" refreshKey="1">
          <span>聊天</span>
        </ProductionWorkspace>,
      ),
    )
    // Only owned responses are accepted, so use the matching conversation for this selection.
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <span>聊天</span>
        </ProductionWorkspace>,
      ),
    )
    const prose = host.querySelector('.production-scene p')!
    const range = document.createRange()
    range.selectNodeContents(prose)
    await act(async () => {
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(host.querySelector('[aria-label="引用到对话"]')).not.toBeNull()
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(host.querySelector('[aria-label="引用到对话"]')).toBeNull()
    expect(document.activeElement).toBe(prose)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('shows the failed submission reference rather than the newly selected panel context', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const clear = vi.fn()
  try {
    await act(async () =>
      root.render(
        <ProductionQuoteChip
          conversationId="conversation"
          frozenContext={{
            documentId: 'doc',
            revision: 1,
            target: 'scene',
            sceneId: 'old-scene',
            quote: { start: 0, end: 3, text: '旧引用' },
          }}
          onRemove={clear}
        />,
      ),
    )
    expect(host.textContent).toContain('旧引用')
    expect(host.textContent).toContain('V1')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click())
    expect(clear).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
