// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Sidebar from '../../components/Sidebar'
import type { CanvasProject } from '../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { useLibraryStore } from '../../features/library/store'
import { installAppRouting } from '../../lib/appRoute'
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

beforeEach(() => {
  useStore.setState({ appMode: 'image', sidebarExpanded: null })
  useLibraryStore.setState({ onLibraryPage: false, tab: 'assets' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Sidebar />))
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

it('对话与画布用两个标签切换，查看全部打开项目列表', () => {
  expect(entry('对话').getAttribute('aria-pressed')).toBe('true')
  expect(entry('画布').getAttribute('aria-pressed')).toBe('false')
  expect(entry('新建对话')).toBeDefined()

  act(() => entry('画布').click())
  expect(entry('画布').getAttribute('aria-pressed')).toBe('true')
  expect(entry('新建画布')).toBeDefined()
  expect(useStore.getState().appMode).toBe('image')

  act(() => entry('查看全部 →').click())
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

  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('13rem')
  expect(host.querySelectorAll('nav')).toHaveLength(2)
})

it('品牌在侧栏里，不再挂在顶栏上', () => {
  expect(host.textContent).toContain('幕芽')
})

it('画布左上角 Logo 返回创作首页并更新地址', () => {
  window.history.replaceState(null, '', '/p/canvas-example')
  act(() => useStore.setState({ appMode: 'canvas', sidebarExpanded: false }))
  const stop = installAppRouting()
  try {
    act(() => entry('主页').click())
    expect(useStore.getState().appMode).toBe('image')
    expect(window.location.pathname).toBe('/image')
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

it('每个标签最多列五条，切换后只列那一种', () => {
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
  expect(rows('canvas-')).toHaveLength(0)

  act(() => entry('画布').click())
  expect(rows('chat-')).toHaveLength(0)
  expect(rows('canvas-')).toHaveLength(3)
})
