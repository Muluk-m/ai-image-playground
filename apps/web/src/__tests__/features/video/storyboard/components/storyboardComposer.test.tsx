// @vitest-environment jsdom
import { type StoryboardPlan, VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoryboardComposer from '../../../../../features/video/storyboard/components/StoryboardComposer'
import {
  INITIAL_STORYBOARD_DRAFT,
  useStoryboardStore,
} from '../../../../../features/video/storyboard/store'
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
const SUPPORT = VIDEO_MODEL_SUPPORT['grok-imagine-video']!

const PLAN: StoryboardPlan = {
  title: '夏日冰饮',
  summary: '一镜讲清一杯冰饮的诞生',
  videoPrompt: '一只挂满水珠的玻璃杯，晨光吧台，写实',
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
  useStore.setState({ showToast: vi.fn() })
  useStoryboardStore.setState({
    storyboards: [],
    activeId: null,
    loadingSince: null,
    draft: { ...INITIAL_STORYBOARD_DRAFT, idea: '一杯夏日冰饮', shotImages: false },
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

function planButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) =>
    /生成脚本|生成中/.test(item.textContent ?? ''),
  )
  if (!button) throw new Error('没找到生成脚本按钮')
  return button
}

describe('生成脚本按钮', () => {
  it('跑起来后读秒，跑完回到原文案', async () => {
    act(() => root.render(<StoryboardComposer support={SUPPORT} onPickReference={vi.fn()} />))

    expect(planButton().textContent).toBe('生成脚本')

    act(() => planButton().click())

    expect(planButton().textContent).toBe('生成中 0s')
    expect(planButton().disabled).toBe(true)
    expect(host.textContent).toContain('通常 60 秒')

    act(() => vi.advanceTimersByTime(12_000))

    expect(planButton().textContent).toBe('生成中 12s')

    await act(async () => {
      settlePlan(PLAN)
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(planButton().textContent).toBe('生成脚本')
    expect(planButton().disabled).toBe(false)
    expect(host.textContent).not.toContain('通常 60 秒')
  })
})
