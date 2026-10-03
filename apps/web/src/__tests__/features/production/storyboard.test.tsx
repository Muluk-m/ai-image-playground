// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionShotPane from '../../../features/production/components/ProductionShotPane'
import ProductionWorkspace from '../../../features/production/components/ProductionWorkspace'
import { openProductionContent } from '../../../features/production/lib/productionContext'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})
it('edits and reorders stable shots through the document HTTP boundary without inventing missing fields', async () => {
  const saved = vi.fn()
  const doc: ProductionDocument = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 3,
    updatedAt: 1,
    content: {
      title: '最后一班车',
      setting: '',
      outline: '',
      scenes: [],
      shots: [
        { id: 'approach', description: '走向站台', lookIds: [], durationSeconds: 4 },
        { id: 'depart', description: '车门关闭', lookIds: ['expired-look'], dialogue: '等一等' },
      ],
    },
  }
  request.mockImplementation(
    async () =>
      new Response(JSON.stringify({ document: doc, history: [], storyboardProposals: [] })),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<ProductionShotPane document={doc} onClose={() => {}} onSaved={saved} />),
    )
    expect(host.textContent).toContain('车门关闭')
    expect(host.textContent).toContain('引用已失效')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑分镜"]')!.click())
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="上移镜头 2"]')!.click(),
    )
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '车门在雨声中关闭。'.repeat(100),
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-action="save-shots"]')!.click(),
    )
    const call = request.mock.calls.find(([, init]) => init.method === 'PUT')!
    const mutation = JSON.parse(call[1].body)
    expect(mutation.baseRevision).toBe(3)
    expect(mutation.content.shots.map((shot: { id: string }) => shot.id)).toEqual([
      'depart',
      'approach',
    ])
    expect(mutation.content.shots[0]).toMatchObject({ dialogue: '等一等' })
    expect(mutation.content.shots[0].durationSeconds).toBeUndefined()
    expect(mutation.content.shots[0].description).toBe('车门在雨声中关闭。'.repeat(100))
    expect(saved).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('opens storyboard results after a closed workspace mounts and keeps the conversation visible', async () => {
  const doc = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 1,
    updatedAt: 1,
    content: {
      title: '雨夜分镜',
      setting: '',
      outline: '',
      scenes: [],
      shots: [{ id: 'one', description: '灯光映照雨水。', lookIds: [] }],
    },
  }
  request.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ document: doc, history: [], assetProposals: [], storyboardProposals: [] }),
      ),
  )
  openProductionContent('conversation', 'storyboard')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="result">
          <span>继续对话</span>
        </ProductionWorkspace>,
      ),
    )
    expect(host.querySelector('[aria-label="编辑分镜"]')).not.toBeNull()
    expect(host.textContent).toContain('灯光映照雨水。')
    expect(host.textContent).toContain('继续对话')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
