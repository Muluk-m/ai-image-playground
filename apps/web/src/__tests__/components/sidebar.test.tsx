// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Sidebar from '../../components/Sidebar'
import { type CanvasProject, projectRepository } from '../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { useLibraryStore } from '../../features/library/store'
import { installWorkbenchNavigation } from '../../lib/navigation/workbenchNavigation'
import { useStore } from '../../store'

vi.mock('../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/channels/videoChannels')>()),
  isVideoModeAvailable: () => true,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  useStore.setState({ appMode: 'image', sidebarExpanded: null })
  useLibraryStore.setState({ onLibraryPage: false, tab: 'assets' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<Sidebar />)
    await useCanvasProjectStore.getState().load()
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function entry(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (one) => one.getAttribute('aria-label') === label || one.textContent === label,
  )
  if (!button) throw new Error(`侧栏没有「${label}」`)
  return button
}

it('顶部三项：创作 / 探索 / 资产，选中的那个自己标出来', () => {
  act(() => entry('创作').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('image')
  expect(entry('创作').getAttribute('aria-pressed')).toBe('true')
  expect(entry('资产').getAttribute('aria-pressed')).toBe('false')

  act(() => entry('资产').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('library')
})

it('对话与画布分成两区，各自能新建，查看全部打开项目列表', () => {
  expect(host.textContent).toContain('对话')
  expect(host.textContent).toContain('画布')
  expect(entry('新建对话')).toBeDefined()
  expect(entry('新建画布')).toBeDefined()
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent === '对话' || button.getAttribute('aria-label') === '对话',
    ),
  ).toBe(false)

  act(() => entry('查看全部').click())
  expect(useStore.getState().appMode).toBe('library')
  expect(useLibraryStore.getState().tab).toBe('projects')
  expect(entry('资产').getAttribute('aria-pressed')).toBe('true')
})

it('宽屏侧栏可收起并重新展开', () => {
  // 宽屏那条栏 + 窄屏底部条，别处两条都在。
  expect(host.querySelectorAll('nav')).toHaveLength(2)

  act(() => useStore.getState().toggleSidebar())

  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('0px')
  expect(host.querySelectorAll('nav')).toHaveLength(1)

  act(() => entry('主导航').click())

  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('264px')
  expect(host.querySelectorAll('nav')).toHaveLength(2)
  const nav = host.querySelector('nav')
  expect(nav?.className).toContain('bg-sidebar')
  expect(nav?.className).not.toContain('border-r')
})

it('品牌在侧栏里，用字标而不是纯文字', () => {
  expect(host.querySelector('img[src="/brand/muvloom-wordmark-dark.svg"]')).not.toBeNull()
  expect(entry('幕芽')).toBeDefined()
})

it('画布左上角 Logo 返回创作首页并更新地址', () => {
  window.history.replaceState(null, '', '/p/canvas-example')
  act(() => useStore.setState({ appMode: 'canvas', sidebarExpanded: false }))
  const stop = installWorkbenchNavigation()
  try {
    act(() => entry('主页').click())
    expect(useStore.getState().appMode).toBe('image')
    expect(window.location.pathname).toBe('/')
  } finally {
    stop()
    window.history.replaceState(null, '', '/')
  }
})

function seed(experience: 'chat' | 'canvas', count: number): CanvasProject[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${experience}-${index}`,
    name: `${experience}-${index}`,
    customName: true,
    conversationId: null,
    sceneKey: `${experience}-${index}`,
    createdAt: index,
    updatedAt: 100 - index,
    hasContent: true,
    kind: 'image',
    experience,
  }))
}

it('同一会话的云端与旧本机存档只列一个入口，旧链接仍标记当前对话', () => {
  const cloud = { ...seed('chat', 1)[0], conversationId: 'shared', cloud: { revision: 1 } }
  const legacy = { ...cloud, id: 'legacy:canvas:conversation:shared', cloud: undefined }
  act(() => {
    useStore.setState({ appMode: 'canvas', sidebarExpanded: true })
    useCanvasProjectStore.setState({
      projects: [legacy, cloud],
      cloudCatalog: {},
      activeId: legacy.id,
      loaded: true,
    })
  })
  const rows = [...host.querySelectorAll('span.truncate')].filter(
    (el) => el.textContent === cloud.name,
  )
  expect(rows).toHaveLength(1)
  expect(rows[0].closest('.group\\/row')?.className).toContain('bg-accent')
  expect(useCanvasProjectStore.getState().projects).toHaveLength(2)
})

it('对话和画布同时列出，每区最多五条，空项目用图标缩略图', () => {
  act(() =>
    useCanvasProjectStore.setState({
      projects: [...seed('chat', 7), ...seed('canvas', 3)],
      cloudCatalog: {},
      loaded: true,
    }),
  )
  const rows = (prefix: string) =>
    [...host.querySelectorAll('span.truncate')].filter((one) => one.textContent?.startsWith(prefix))
  expect(rows('chat-')).toHaveLength(5)
  expect(rows('canvas-')).toHaveLength(3)
  expect(host.querySelectorAll('[data-project-thumb="chat"]')).toHaveLength(5)
  expect(host.querySelectorAll('[data-project-thumb="canvas"]')).toHaveLength(3)
})

it('有封面的项目用封面图', () => {
  act(() =>
    useCanvasProjectStore.setState({
      projects: [{ ...seed('chat', 1)[0]!, cover: 'https://example.com/cover.jpg' }],
      cloudCatalog: {},
      loaded: true,
    }),
  )
  const thumb = host.querySelector('[data-project-thumb="cover"] img')
  expect(thumb?.getAttribute('src')).toBe('https://example.com/cover.jpg')
})

it('进入画布后，当前项目在对应一行高亮', () => {
  act(() =>
    useCanvasProjectStore.setState({
      projects: [...seed('chat', 2), ...seed('canvas', 2)],
      cloudCatalog: {},
      activeId: 'canvas-1',
      loaded: true,
    }),
  )
  expect(host.querySelector('.bg-accent')).toBeNull()

  act(() => useStore.setState({ appMode: 'canvas', sidebarExpanded: true }))
  const active = [...host.querySelectorAll('span.truncate')].find(
    (el) => el.textContent === 'canvas-1',
  )
  expect(active?.closest('.group\\/row')?.className).toContain('bg-accent')

  act(() => useCanvasProjectStore.setState({ activeId: 'chat-0' }))
  const next = [...host.querySelectorAll('span.truncate')].find((el) => el.textContent === 'chat-0')
  expect(next?.closest('.group\\/row')?.className).toContain('bg-accent')
})

it('进入对话或画布都默认摊开宽栏', () => {
  act(() =>
    useCanvasProjectStore.setState({
      projects: [...seed('chat', 1), ...seed('canvas', 1)],
      cloudCatalog: {},
      activeId: 'chat-0',
      loaded: true,
    }),
  )
  act(() => useStore.getState().setAppMode('canvas'))
  expect(host.querySelectorAll('nav')).toHaveLength(2)
  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('264px')

  act(() => useCanvasProjectStore.setState({ activeId: 'canvas-0' }))
  expect(host.querySelectorAll('nav')).toHaveLength(2)
  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('264px')
})

it('shows a catalog failure with a working retry instead of leaking an unhandled rejection', async () => {
  await act(async () => {
    await useCanvasProjectStore.getState().load()
  })
  act(() => root.unmount())
  useCanvasProjectStore.setState({ loaded: false, error: null })
  const read = vi
    .spyOn(projectRepository, 'list')
    .mockRejectedValueOnce(new DOMException('Temporarily unavailable', 'UnknownError'))
  root = createRoot(host)
  try {
    await act(async () => {
      root.render(<Sidebar />)
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('重新加载')
    await act(async () => {
      entry('重新加载').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await useCanvasProjectStore.getState().load()
    })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(useCanvasProjectStore.getState().loaded).toBe(true)
  } finally {
    read.mockRestore()
  }
})
