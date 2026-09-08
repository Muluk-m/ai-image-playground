// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoryboardShotCard from '../../../../../features/video/storyboard/components/StoryboardShotCard'
import type {
  StoryboardRecord,
  StoryboardShotRecord,
} from '../../../../../features/video/storyboard/types'
import type { VideoTask } from '../../../../../features/video/types'
import { useStore } from '../../../../../store'
import type { TaskRecord } from '../../../../../types'
import { videoTask } from '../../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_800_000_000_000

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function shot(overrides: Partial<StoryboardShotRecord> = {}): StoryboardShotRecord {
  return {
    no: 1,
    title: '开场',
    description: '冰块落进玻璃杯',
    camera: '推镜',
    line: '',
    startSeconds: 0,
    seconds: 5,
    imagePrompt: '玻璃杯特写',
    videoPrompt: '冰块缓缓落下',
    imageTaskId: null,
    imageId: null,
    videoTaskId: null,
    ...overrides,
  }
}

const RECORD: StoryboardRecord = {
  id: 'sb-1',
  createdAt: NOW,
  updatedAt: NOW,
  title: '夏日冰饮',
  summary: '三镜讲清一杯冰饮的诞生',
  idea: '冰饮广告',
  aspectRatio: '16:9',
  totalSeconds: 5,
  videoPrompt: '一杯夏日冰饮，吧台，写实\n镜头1（0-5秒）：冰块落进玻璃杯',
  style: '写实',
  referenceImageId: null,
  shotImagesRequested: true,
  videoTaskId: null,
  shots: [],
}

function imageTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'image-1',
    prompt: '',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: NOW,
    finishedAt: null,
    elapsed: null,
    ...overrides,
  }
}

function render(props: { shot: StoryboardShotRecord; imageTask?: TaskRecord; video?: VideoTask }) {
  act(() =>
    root.render(
      <StoryboardShotCard
        record={RECORD}
        shot={props.shot}
        imageTask={props.imageTask}
        videoTask={props.video}
        onPlay={vi.fn()}
      />,
    ),
  )
}

describe('a shot whose video is generating', () => {
  it('reads the elapsed time next to what this model usually takes', () => {
    render({
      shot: shot({ imageId: 'img-1', videoTaskId: 'task-1' }),
      video: videoTask({ status: 'running', createdAt: NOW - 7_000, completedAt: null }),
    })

    expect(host.textContent).toContain('7s')
    expect(host.textContent).toContain('通常 40 秒')
    expect(host.textContent).not.toContain('视频生成中')
  })

  it('keeps counting while the task only sits in the queue', () => {
    render({
      shot: shot({ imageId: 'img-1', videoTaskId: 'task-1' }),
      video: videoTask({ status: 'queued', createdAt: NOW - 3_000, completedAt: null }),
    })

    expect(host.textContent).toContain('3s')
    expect(host.textContent).toContain('排队')

    act(() => vi.advanceTimersByTime(2_000))

    expect(host.textContent).toContain('5s')
  })
})

describe('a shot still waiting on its image', () => {
  it('ticks the elapsed time under the label', () => {
    render({
      shot: shot({ imageTaskId: 'image-1' }),
      imageTask: imageTask({ createdAt: NOW - 4_000 }),
    })

    expect(host.textContent).toContain('分镜图生成中 4s')

    act(() => vi.advanceTimersByTime(3_000))

    expect(host.textContent).toContain('分镜图生成中 7s')
  })
})
