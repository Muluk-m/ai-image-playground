// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../../../features/video/store'
import DirectorGeneration from '../../../../../features/video/storyboard/components/DirectorGeneration'
import { useStoryboardStore } from '../../../../../features/video/storyboard/store'
import type { StoryboardRecord } from '../../../../../features/video/storyboard/types'
import { setChannels } from '../../../../../lib/channels/channelStore'
import { AGNES_CHANNEL } from '../../fixtures'

const guard = vi.hoisted(() => vi.fn(() => ({ blocked: false, estimatedCredits: 300 })))
vi.mock('../../../../../lib/privateOverlay', () => ({ usePrivateSubmissionGuard: guard }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const record: StoryboardRecord = {
  id: 'board',
  createdAt: 1,
  updatedAt: 1,
  title: '浴缸',
  summary: '三面展示',
  idea: '展示',
  aspectRatio: '16:9',
  totalSeconds: 15,
  videoPrompt: '镜头1（0-15秒）：三面展示',
  style: '不限',
  referenceImageIds: [],
  shotImagesRequested: true,
  videoTaskId: null,
  shots: [
    {
      no: 1,
      title: '开场',
      description: '展示',
      camera: '推进',
      line: '',
      startSeconds: 0,
      seconds: 5,
      imagePrompt: '浴缸',
      videoPrompt: '推进',
      imageTaskId: null,
      imageId: 'image-1',
      videoTaskId: null,
    },
  ],
}

// Radix 的下拉要用 pointer capture 和 scrollIntoView，jsdom 两样都没有；补上之后才能
// 像真人一样打开它、点一项。选项渲染在 portal 里，所以从 document 找而不是从 host 找。
function stubPointerApis(): void {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture = () => false
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.scrollIntoView = () => {}
  const globals = globalThis as unknown as Record<string, unknown>
  globals.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.DOMRect ??= class {
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
  }
}

// Radix 只认 pointerType 是 mouse 的指针事件，而 jsdom 既没有 PointerEvent 也不会给
// MouseEvent 补这个属性。
function pointer(type: string): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

function chooseOption(triggerLabel: string, optionText: string): void {
  const trigger = document.querySelector<HTMLElement>(`[aria-label="${triggerLabel}"]`)
  if (!trigger) throw new Error(`no trigger ${triggerLabel}`)
  act(() => {
    trigger.dispatchEvent(pointer('pointerdown'))
  })
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (node) => node.textContent?.trim() === optionText,
  )
  if (!option) throw new Error(`no option ${optionText}`)
  act(() => {
    option.dispatchEvent(pointer('pointermove'))
    option.dispatchEvent(pointer('pointerup'))
  })
}

function triggerText(label: string): string {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.textContent?.trim() ?? ''
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  stubPointerApis()
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([AGNES_CHANNEL])
  useVideoStore.setState({
    draft: { ...INITIAL_VIDEO_DRAFT, model: 'agnes-video-2.5-flash', resolution: '720p' },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <DirectorGeneration
        record={record}
        shot={record.shots[0]}
        initialScope="whole"
        onClose={() => {}}
        onLibrary={() => {}}
        onSubmitted={() => {}}
      />,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setChannels([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('15秒分镜在Agnes下默认10秒，提供模型支持的时长并按所选时长计费和提交', async () => {
  expect(triggerText('分镜视频时长')).toBe('10 秒')
  expect(host.textContent).toContain('原分镜 15 秒，本次按 10 秒生成')
  expect(host.textContent).not.toContain('时长只支持')
  expect(guard).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 10 }))
  chooseOption('分镜视频时长', '8 秒')
  expect(guard).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 8 }))
  const submit = vi
    .spyOn(useStoryboardStore.getState(), 'generateWholeVideo')
    .mockResolvedValue('task')
  const button = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === '生成 8 秒视频',
  )!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(submit).toHaveBeenCalledWith('board', 8)
})
it('切换到单镜时采用镜头时长，仍可选择10秒', () => {
  act(() =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('当前镜头'))!
      .click(),
  )
  expect(triggerText('分镜视频时长')).toBe('5 秒')
  chooseOption('分镜视频时长', '10 秒')
  expect(host.textContent).toContain('生成 10 秒视频')
})
