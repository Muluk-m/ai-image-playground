// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionDocumentPane from '../../../features/production/components/ProductionDocumentPane'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})
it('keeps a reopened newer local draft when the previous mounted editor receives its save receipt', async () => {
  const doc: ProductionDocument = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 1,
    updatedAt: 1,
    content: {
      title: '雨夜',
      setting: '',
      outline: '',
      scenes: [{ id: 'scene', title: '站台', body: '起稿' }],
    },
  }
  let finish: (response: Response) => void = () => {}
  request.mockImplementation((_url, init) =>
    init?.method === 'PUT'
      ? new Promise<Response>((resolve) => {
          finish = resolve
        })
      : Promise.resolve(
          new Response(JSON.stringify({ document: doc, history: [], proposals: [] })),
        ),
  )
  const saved = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (key: string) =>
    root.render(
      <ProductionDocumentPane key={key} document={doc} onClose={() => {}} onSaved={saved} />,
    )
  const button = (label: string) =>
    Array.from(host.querySelectorAll('button')).find((one) => one.textContent === label)!
  const text = (value: string) => {
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="场景正文"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  try {
    await act(async () => render('first'))
    await act(async () => button('编辑').click())
    await act(async () => text('已发送的修改'))
    await act(async () => button('完成').click())
    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    await act(async () => root.render(null))
    await act(async () => render('reopened'))
    await act(async () => text('后来继续写的草稿'))
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({
            document: {
              ...doc,
              revision: 2,
              content: {
                ...doc.content,
                scenes: [{ ...doc.content.scenes[0], body: '已发送的修改' }],
              },
            },
            history: [],
          }),
        ),
      ),
    )
    expect(saved).toHaveBeenCalledOnce()
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('后来继续写的草稿')
    await act(async () => root.render(null))
    await act(async () => render('after-refresh'))
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('后来继续写的草稿')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
