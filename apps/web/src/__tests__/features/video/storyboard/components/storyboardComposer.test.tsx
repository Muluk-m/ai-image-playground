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
import type { TaskRecord } from '../../../../../types'

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

const showToast = vi.fn()

function doneTask(imageId: string): TaskRecord {
  return {
    id: `task-${imageId}`,
    prompt: '',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [imageId],
    status: 'done',
    error: null,
    createdAt: 1_000,
    finishedAt: 2_000,
    elapsed: 1_000,
  }
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
  useStore.setState({ showToast, tasks: [] })
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
    act(() => root.render(<StoryboardComposer support={SUPPORT} />))

    expect(planButton().textContent).toBe('生成脚本')

    // 参考图先要逐张读出 data URL，所以请求要等一轮微任务才发出去。
    await act(async () => {
      planButton().click()
    })

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

function references(): HTMLLIElement[] {
  const list = host.querySelector('ul[aria-label="参考图"]')
  if (!list) throw new Error('没找到参考图列表')
  return [...list.querySelectorAll('li')]
}

function render(referenceImageIds: string[]) {
  useStoryboardStore.setState((state) => ({ draft: { ...state.draft, referenceImageIds } }))
  act(() => root.render(<StoryboardComposer support={SUPPORT} />))
}

describe('参考图', () => {
  it('选了几张就摆几张，没满时留着上传与选图', () => {
    render(['ref-1', 'ref-2'])

    expect(references()).toHaveLength(3)
    expect(host.textContent).toContain('上传')
    expect(host.textContent).toContain('选图')
  })

  it('第 4 张之后收起添加位，再点素材条只提示', () => {
    useStore.setState({ showToast, tasks: [doneTask('ref-5')] })
    render(['ref-1', 'ref-2', 'ref-3', 'ref-4'])

    expect(references()).toHaveLength(4)
    expect(host.textContent).not.toContain('上传')

    const strip = host.querySelector('ul[aria-label="素材库 · 最近出图"] button')
    act(() => (strip as HTMLButtonElement).click())

    expect(showToast).toHaveBeenCalledWith('最多 4 张参考图', 'error')
    expect(useStoryboardStore.getState().draft.referenceImageIds).toHaveLength(4)
  })

  it('点掉一张就少一张', () => {
    render(['ref-1', 'ref-2'])

    const remove = references()[0]!.querySelector('button')
    act(() => (remove as HTMLButtonElement).click())

    expect(useStoryboardStore.getState().draft.referenceImageIds).toEqual(['ref-2'])
  })
})
