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
  useStore.setState({ appMode: 'canvas' })
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
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent === label)
  if (!button) throw new Error(`侧栏没有「${label}」`)
  return button
}

it('每个创作入口都是一个独立去处，选中的那个自己标出来', () => {
  act(() => entry('生图').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('image')
  expect(entry('生图').getAttribute('aria-pressed')).toBe('true')
  expect(entry('画布').getAttribute('aria-pressed')).toBe('false')

  act(() => entry('视频').dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(useStore.getState().appMode).toBe('video')
})

it('素材与模板和别的入口同一层级：换地址、换主区', () => {
  act(() => entry('模板').dispatchEvent(new MouseEvent('click', { bubbles: true })))

  expect(useStore.getState().appMode).toBe('templates')
  expect(entry('模板').getAttribute('aria-pressed')).toBe('true')
})
