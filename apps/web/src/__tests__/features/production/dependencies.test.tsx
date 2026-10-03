// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionDependencyNotice from '../../../features/production/components/ProductionDependencyNotice'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => request.mockReset())
it('names changed sources and acknowledges only the selected saved shot without submitting generation', async () => {
  const doc: ProductionDocument = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 3,
    updatedAt: 1,
    content: { title: '雨夜', setting: '', outline: '', scenes: [] },
  }
  const saved = vi.fn()
  request.mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? {
                document: { ...doc, revision: 4 },
                history: [],
                shotDependencyStates: [{ shotId: 'shot', outdated: false, changed: [] }],
              }
            : {
                document: doc,
                history: [],
                shotDependencyStates: [
                  {
                    shotId: 'shot',
                    outdated: true,
                    changed: [
                      { kind: 'scene', id: 'station', name: '雨夜站台', missing: false },
                      { kind: 'look', id: 'coat', name: '黄色雨衣', missing: true },
                    ],
                  },
                ],
              },
        ),
      ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionDependencyNotice
          document={doc}
          target={{ kind: 'shot', id: 'shot' }}
          onSaved={saved}
        />,
      ),
    )
    expect(host.textContent).toContain('雨夜站台')
    expect(host.textContent).toContain('黄色雨衣')
    expect(host.textContent).toContain('已删除或失效')
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-action="refresh-production-dependencies"]')!
        .click(),
    )
    const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]).toContain('/shots/shot/refresh')
    expect(JSON.parse(writes[0]![1].body)).toMatchObject({ baseRevision: 3 })
    expect(saved).toHaveBeenCalledOnce()
    expect(host.textContent).not.toContain('雨夜站台')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
it('keeps an outdated version without writing and preserves the warning on revision conflict', async () => {
  const doc: ProductionDocument = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 3,
    updatedAt: 1,
    content: { title: '雨夜', setting: '', outline: '', scenes: [] },
  }
  const saved = vi.fn()
  request.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? new Response(
          JSON.stringify({ error: 'production_conflict', current: { ...doc, revision: 4 } }),
          { status: 409 },
        )
      : new Response(
          JSON.stringify({
            document: doc,
            history: [],
            dependencyStates: [
              {
                clipId: 'clip',
                outdated: true,
                changed: [{ kind: 'shot', id: 'shot', name: '站台远景', missing: false }],
              },
            ],
          }),
        ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionDependencyNotice
          document={doc}
          target={{ kind: 'clip', id: 'clip' }}
          onSaved={saved}
        />,
      ),
    )
    const button = (text: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent === text)!
    await act(async () => button('保留现有版本').click())
    expect(host.textContent).toContain('已保留现有版本')
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    await act(async () => button('查看变化').click())
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-action="refresh-production-dependencies"]')!
        .click(),
    )
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.textContent).toContain('站台远景')
    expect(saved).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
