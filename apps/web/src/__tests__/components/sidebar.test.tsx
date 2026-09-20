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

it('一级入口只有四个，选中的那个自己标出来', () => {
  act(() => entry('创作').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('image')
  expect(entry('创作').getAttribute('aria-pressed')).toBe('true')
  expect(entry('资产').getAttribute('aria-pressed')).toBe('false')

  act(() => entry('资产').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('library')

  act(() => entry('项目').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('projects')
})

it('画布与视频不占导航位：它们只从项目进', () => {
  expect(() => entry('画布')).toThrow()
  expect(() => entry('视频')).toThrow()
})

it('侧栏在画布里也留着：没有顶栏之后，它是唯一的常驻导航', () => {
  act(() => useStore.getState().setAppMode('canvas'))

  expect(host.querySelector('nav')).not.toBeNull()
  // 画布是「创作」的一种模式，所以创作那项仍然标亮。
  expect(entry('创作').getAttribute('aria-pressed')).toBe('true')
})

it('品牌在侧栏里，不再挂在顶栏上', () => {
  expect(host.textContent).toContain('幕芽')
})
