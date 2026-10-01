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
const documentView = {
  id: 'reading-doc',
  conversationId: 'reading-conversation',
  projectId: null,
  revision: 1,
  updatedAt: 1,
  content: {
    title: '剧本',
    setting: '设定',
    outline: '大纲',
    scenes: [{ id: 'scene', title: '第一场', body: '场景正文' }],
  },
}
function arrange() {
  request.mockImplementation(async () =>
    Response.json({ document: documentView, history: [], proposals: [], assetProposals: [] }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  return {
    host,
    root,
    render: () =>
      root.render(
        <ProductionWorkspace conversationId="reading-conversation" refreshKey="1">
          <input aria-label="对话输入" />
        </ProductionWorkspace>,
      ),
  }
}
it('restores the script tab, scene folds and scroll position after closing and reopening the pane', async () => {
  const { host, root, render } = arrange()
  const click = (label: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  try {
    await act(async () => render())
    const scene = host.querySelector('details')!
    await act(async () => {
      scene.open = false
      scene.dispatchEvent(new Event('toggle'))
    })
    await act(async () =>
      Array.from(host.querySelectorAll('.production-tabs button'))
        .find((b) => b.textContent === '故事大纲')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const scroll = host.querySelector<HTMLDivElement>('.production-document-scroll')!
    await act(async () => {
      scroll.scrollTop = 280
      scroll.dispatchEvent(new Event('scroll'))
    })
    await click('收起内容')
    await click('打开剧本')
    expect(host.querySelector('.production-tabs [aria-pressed="true"]')?.textContent).toBe(
      '故事大纲',
    )
    expect(host.querySelector('.production-document-scroll')?.scrollTop).toBe(280)
    await act(async () =>
      Array.from(host.querySelectorAll('.production-tabs button'))
        .find((b) => b.textContent === '正文')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    expect(host.querySelector('details')?.open).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
it('closes the asset drawer with Escape and returns focus to its trigger without losing chat input', async () => {
  const { host, root, render } = arrange()
  try {
    await act(async () => render())
    const trigger = host.querySelector<HTMLButtonElement>('.production-assets-trigger')!
    const input = host.querySelector<HTMLInputElement>('input')!
    input.value = '继续这个镜头'
    await act(async () => {
      trigger.focus()
      trigger.click()
    })
    expect(host.querySelector('.production-workspace')?.getAttribute('data-assets-drawer')).toBe(
      'true',
    )
    expect(host.querySelector('.production-assets')?.contains(document.activeElement)).toBe(true)
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    )
    expect(host.querySelector('.production-workspace')?.getAttribute('data-assets-drawer')).toBe(
      'false',
    )
    expect(document.activeElement).toBe(trigger)
    expect(input.value).toBe('继续这个镜头')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
