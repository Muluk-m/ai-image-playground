// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import VideoMode from '../../../../features/video/components/VideoMode'
import { useVideoStore } from '../../../../features/video/store'
import { useStoryboardStore } from '../../../../features/video/storyboard/store'
import { useStore } from '../../../../store'
import { videoTask } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../../lib/clientCapabilities', () => ({
  isClientCapabilityEnabled: () => true,
}))
vi.mock('../../../../features/video/components/VideoFeed', () => ({
  default: () => <div>视频结果流</div>,
}))
vi.mock('../../../../features/video/components/VideoComposer', () => ({
  default: () => <div />,
}))
vi.mock('../../../../features/video/storyboard/components/StoryboardBoard', () => ({
  default: () => <div />,
}))
vi.mock('../../../../features/video/storyboard/components/StoryboardComposer', () => ({
  default: () => <div />,
}))
vi.mock('../../../../features/video/storyboard/components/StoryboardLibrary', () => ({
  default: () => <div />,
}))

let host: HTMLDivElement
let root: Root

function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<VideoMode />))
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ tasks: [], showToast: vi.fn() })
  useLibraryStore.setState({ loadAssets: vi.fn() } as never)
  useStoryboardStore.setState({ storyboards: [], activeId: null, loadError: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function pendingBar(): HTMLButtonElement | null {
  return host.querySelector('button[aria-label="查看生成中的视频"]')
}

function feedRendered(): boolean {
  return host.textContent?.includes('视频结果流') ?? false
}

// 导演台是 4 选 1 的视图，进行中的任务原本只在「生成与成片」里渲染：一切到导演台，
// 整个 feed 连同在跑的任务一起从 DOM 上消失。
it('keeps running tasks reachable from the director view', () => {
  useVideoStore.setState({
    tasks: [videoTask({ id: 'a', status: 'running', completedAt: null })],
    loaded: true,
  })
  render()

  expect(feedRendered()).toBe(false)
  expect(pendingBar()?.textContent).toContain('1')
})

it('opens the results view from the running-task entry', () => {
  useVideoStore.setState({
    tasks: [videoTask({ id: 'a', status: 'running', completedAt: null })],
    loaded: true,
  })
  render()

  act(() => pendingBar()?.click())

  expect(feedRendered()).toBe(true)
})

it('stays out of the way when nothing is running', () => {
  useVideoStore.setState({ tasks: [videoTask({ id: 'a' })], loaded: true })
  render()

  expect(pendingBar()).toBeNull()
})
