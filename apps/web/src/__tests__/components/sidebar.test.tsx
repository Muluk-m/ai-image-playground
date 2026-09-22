// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Sidebar from '../../components/Sidebar'
import { useLibraryStore } from '../../features/library/store'
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
  useStore.setState({ appMode: 'image' })
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

it('画布不占顶部导航位：项目是资产的一部分，「画布」标题和「全部」都去资产的项目标签', () => {
  expect(() => entry('项目')).toThrow()

  act(() => entry('全部').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('library')
  expect(useLibraryStore.getState().tab).toBe('projects')
  expect(entry('资产').getAttribute('aria-pressed')).toBe('true')

  act(() => useStore.getState().setAppMode('image'))
  act(() => entry('画布').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('library')
  expect(useLibraryStore.getState().tab).toBe('projects')
})

it('画布是沉浸式的：宽栏不出现，连手动展开都不给', () => {
  // 宽屏那条栏 + 窄屏底部条，别处两条都在。
  expect(host.querySelectorAll('nav')).toHaveLength(2)

  act(() => useStore.getState().setAppMode('canvas'))

  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('0px')
  expect(host.querySelectorAll('nav')).toHaveLength(1)

  act(() => useStore.getState().toggleSidebar())

  expect(document.documentElement.style.getPropertyValue('--app-sidebar-size')).toBe('0px')
  expect(host.querySelectorAll('nav')).toHaveLength(1)
})

it('品牌在侧栏里，不再挂在顶栏上', () => {
  expect(host.textContent).toContain('幕芽')
})
