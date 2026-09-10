// @vitest-environment jsdom
import type { StoryboardPlan } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVideoStore } from '../../../../../features/video/store'
import StoryboardBoard from '../../../../../features/video/storyboard/components/StoryboardBoard'
import { useStoryboardStore } from '../../../../../features/video/storyboard/store'
import type { StoryboardRecord } from '../../../../../features/video/storyboard/types'
import { useStore } from '../../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const planStoryboard = vi.hoisted(() => vi.fn())
const storyboardStore = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  put: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}))

vi.mock('../../../../../lib/storyboardClient', () => ({ planStoryboard }))
vi.mock('../../../../../features/video/storyboard/lib/storyboardStore', () => ({
  storyboardStore,
}))

const NOW = 1_800_000_000_000

const PLAN: StoryboardPlan = {
  title: '夏日冰饮',
  summary: '一镜讲清一杯冰饮的诞生',
  videoPrompt: '一只挂满水珠的玻璃杯，晨光吧台，写实',
  shots: [],
}

const RECORD: StoryboardRecord = {
  id: 'sb-1',
  createdAt: NOW,
  updatedAt: NOW,
  title: '夏日冰饮',
  summary: '一镜讲清一杯冰饮的诞生',
  idea: '冰饮广告',
  aspectRatio: '16:9',
  totalSeconds: 15,
  videoPrompt: '一只挂满水珠的玻璃杯，晨光吧台，写实',
  style: '写实',
  referenceImageIds: [],
  shotImagesRequested: false,
  videoTaskId: null,
  shots: [],
}

let host: HTMLDivElement
let root: Root
let settlePlan: (plan: StoryboardPlan) => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('indexedDB', new IDBFactory())
  planStoryboard.mockImplementation(
    () =>
      new Promise<StoryboardPlan>((resolve) => {
        settlePlan = resolve
      }),
  )
  useStore.setState({ showToast: vi.fn(), tasks: [] })
  useVideoStore.setState({ tasks: [] })
  useStoryboardStore.setState({
    storyboards: [RECORD],
    activeId: RECORD.id,
    loadingSince: null,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function replanButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) =>
    /重写脚本|生成中/.test(item.textContent ?? ''),
  )
  if (!button) throw new Error('没找到重写脚本按钮')
  return button
}

describe('重写脚本按钮', () => {
  it('跑起来后读秒，跑完回到原文案', async () => {
    act(() => root.render(<StoryboardBoard />))

    expect(replanButton().textContent).toBe('重写脚本')

    // 参考图先要逐张读出 data URL，所以请求要等一轮微任务才发出去。
    await act(async () => {
      replanButton().click()
    })

    expect(replanButton().textContent).toBe('生成中 0s')
    expect(replanButton().disabled).toBe(true)
    expect(host.textContent).toContain('通常 60 秒')

    act(() => vi.advanceTimersByTime(9_000))

    expect(replanButton().textContent).toBe('生成中 9s')

    await act(async () => {
      settlePlan(PLAN)
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(replanButton().textContent).toBe('重写脚本')
    expect(host.textContent).not.toContain('通常 60 秒')
  })
})
