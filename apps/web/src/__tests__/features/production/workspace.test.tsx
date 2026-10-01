// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionWorkspace from '../../../features/production/components/ProductionWorkspace'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})

it('does not show the previous conversation script while the next conversation loads', async () => {
  request.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        document: {
          id: 'old',
          conversationId: 'old-conversation',
          projectId: null,
          revision: 1,
          content: { title: '上一会话的剧本', setting: '', outline: '', scenes: [] },
          updatedAt: 1,
        },
        history: [],
      }),
    ),
  )
  request.mockImplementationOnce(() => new Promise(() => {}))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="old-conversation" refreshKey="1">
          <span>会话</span>
        </ProductionWorkspace>,
      ),
    )
    expect(host.textContent).toContain('上一会话的剧本')
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="new-conversation" refreshKey="1">
          <span>新会话</span>
        </ProductionWorkspace>,
      ),
    )
    expect(host.textContent).not.toContain('上一会话的剧本')
    expect(host.textContent).toContain('新会话')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('loads history only when requested and restores a revision through the owned conversation', async () => {
  const content = { title: '新版剧本', setting: '', outline: '', scenes: [] }
  request.mockImplementation(
    async (url: string, init: RequestInit) =>
      new Response(
        JSON.stringify({
          document: {
            id: 'doc',
            conversationId: 'conversation',
            projectId: null,
            revision: init.method === 'POST' ? 3 : 2,
            content,
            updatedAt: 1,
          },
          history: url.includes('?history=true')
            ? [
                {
                  revision: 1,
                  content: { ...content, title: '初稿' },
                  source: 'agent',
                  createdAt: 1,
                },
              ]
            : [],
        }),
      ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <span>会话</span>
        </ProductionWorkspace>,
      ),
    )
    expect(request.mock.calls).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="历史版本"]')!.click())
    expect(request.mock.calls[1]?.[0]).toContain('?history=true')
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((one) => one.textContent === '恢复此版本')!
        .click(),
    )
    const restore = request.mock.calls.find(([url]) => url.endsWith('/restore'))!
    expect(JSON.parse(restore[1].body)).toMatchObject({ baseRevision: 2, revision: 1 })
    expect(host.textContent).toContain('修订版 V3')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('opens the saved script alongside the conversation without replacing its input', async () => {
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        document: {
          id: 'document',
          conversationId: 'conversation',
          projectId: 'project',
          revision: 1,
          content: {
            title: '雨夜来客',
            setting: '旧电车站',
            outline: '一次重逢',
            scenes: [{ id: 'scene', title: '旧站台', body: '林夏收起雨伞。' }],
          },
          updatedAt: 1,
        },
        history: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <textarea aria-label="对话" defaultValue="继续改结尾" />
        </ProductionWorkspace>,
      ),
    )
    expect(host.textContent).toContain('林夏收起雨伞。')
    expect(host.textContent).toContain('雨夜来客')
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="收起内容"]')!
    await act(async () => toggle.click())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="对话"]')?.value).toBe('继续改结尾')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="打开剧本"]')!.click())
    expect(host.textContent).toContain('林夏收起雨伞。')
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://test.local/api/agent/conversations/conversation/production',
    )
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('saves the directly edited text as a new revision through the conversation endpoint', async () => {
  const content = {
    title: '雨夜来客',
    setting: '旧电车站',
    outline: '一次重逢',
    scenes: [{ id: 'scene', title: '旧站台', body: '林夏收起雨伞。' }],
  }
  request.mockImplementation(async (_url: string, init: RequestInit) => {
    const written = init.method === 'PUT' ? JSON.parse(String(init.body)) : null
    return new Response(
      JSON.stringify({
        document: {
          id: 'doc',
          conversationId: 'conversation',
          projectId: null,
          revision: written ? 2 : 1,
          content: written?.content ?? content,
          updatedAt: 2,
        },
        history: [],
      }),
      { status: 200 },
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <textarea aria-label="对话" />
        </ProductionWorkspace>,
      ),
    )
    const button = (label: string) =>
      Array.from(host.querySelectorAll('button')).find((one) => one.textContent === label)!
    await act(async () => button('编辑').click())
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="场景正文"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '林夏打开雨伞。',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('完成').click())
    const put = request.mock.calls.find(([, init]) => init.method === 'PUT')
    expect(JSON.parse(put![1].body)).toMatchObject({
      baseRevision: 1,
      content: { scenes: [{ id: 'scene', body: '林夏打开雨伞。' }] },
    })
    expect(host.textContent).toContain('修订版 V2')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('keeps the local draft after a version conflict and restores it when the pane reopens', async () => {
  const doc = {
    id: 'doc',
    conversationId: 'conversation',
    projectId: null,
    revision: 1,
    content: {
      title: '旧稿',
      setting: '',
      outline: '',
      scenes: [{ id: 'scene', title: '站台', body: '旧正文' }],
    },
    updatedAt: 1,
  }
  request.mockImplementation(
    async (_url: string, init: RequestInit) =>
      new Response(
        JSON.stringify(
          init.method === 'PUT'
            ? { error: 'production_conflict', current: { ...doc, revision: 2 } }
            : { document: doc, history: [] },
        ),
        { status: init.method === 'PUT' ? 409 : 200 },
      ),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionWorkspace conversationId="conversation" refreshKey="1">
          <span>对话保留</span>
        </ProductionWorkspace>,
      ),
    )
    const button = (label: string) =>
      Array.from(host.querySelectorAll('button')).find((one) => one.textContent === label)!
    await act(async () => button('编辑').click())
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="场景正文"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '我的新正文',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('完成').click())
    expect(host.textContent).toContain('内容已有新版本，草稿已保留')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起内容"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="打开剧本"]')!.click())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="场景正文"]')?.value).toBe(
      '我的新正文',
    )
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
