// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { useProductShotsStore } from '../../features/productShots/store'
import { useStoryboardStore } from '../../features/video/storyboard/store'
import type { StoryboardRecord } from '../../features/video/storyboard/types'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function task(id: string, setId: string, status: TaskRecord['status']): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [`out-${id}`],
    status,
    error: null,
    createdAt: Number(id.slice(-1)),
    finishedAt: 9,
    elapsed: 1,
    origin: { setId, shotId: `${id}:v1` },
  }
}

function storyboardTask(id: string): TaskRecord {
  const record = task(id, 'board-1', 'done')
  return { ...record, origin: { setId: 'board-1', shotId: id, kind: 'storyboard' } }
}

function storyboard(): StoryboardRecord {
  return {
    id: 'board-1',
    createdAt: 1,
    updatedAt: 1,
    title: '夏日冰饮',
    summary: '两镜',
    idea: '冰饮',
    aspectRatio: '16:9',
    secondsPerShot: 5,
    style: '不限',
    referenceImageId: null,
    shots: [],
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({
    tasks: [task('task-1', 'job-1', 'done'), task('task-2', 'job-1', 'error')],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
  })
  useProductShotsStore.setState({
    jobs: [
      {
        id: 'job-1',
        name: '折叠浴缸',
        images: [
          {
            imageId: 'img-1',
            versions: [
              {
                id: 'v1',
                taskId: 'task-1',
                plan: '方案',
                prompt: '提示词',
                masked: true,
                mode: 'background',
                createdAt: 1,
              },
              {
                id: 'v2',
                taskId: 'task-2',
                plan: '方案',
                prompt: '提示词',
                masked: true,
                mode: 'replace-product',
                createdAt: 2,
              },
            ],
          },
        ],
        preference: '',
        versionsPerImage: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    loadJobs: vi.fn().mockResolvedValue(undefined),
  })
  useStoryboardStore.setState({ storyboards: [], load: vi.fn().mockResolvedValue(undefined) })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('folding a product shot job in the history', () => {
  it('shows one card named after the job instead of every task', () => {
    act(() => root.render(<TaskGrid />))

    const cards = document.querySelectorAll('[data-set-history-card]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('折叠浴缸')
    expect(cards[0].textContent).toContain('完成 1/2')
    expect(cards[0].textContent).toContain('失败 1')
    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(0)
  })

  it('tags the card with each action the job ran', () => {
    act(() => root.render(<TaskGrid />))

    const tags = document.querySelectorAll('[data-set-history-card] [data-set-history-action]')
    expect([...tags].map((tag) => tag.textContent)).toEqual(['换背景', '换产品'])
  })

  it('falls back to a plain name once the job record is gone', () => {
    useProductShotsStore.setState({ jobs: [] })
    act(() => root.render(<TaskGrid />))

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('商品图任务')
    expect(card?.querySelectorAll('[data-set-history-action]')).toHaveLength(0)
  })

  it('names a storyboard set after the storyboard', () => {
    useStore.setState({ tasks: [storyboardTask('task-3'), storyboardTask('task-4')] })
    useStoryboardStore.setState({ storyboards: [storyboard()] })
    act(() => root.render(<TaskGrid />))

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('夏日冰饮')
  })

  it('lets the card open to its tasks', () => {
    act(() => root.render(<TaskGrid />))

    const toggle = document.querySelector('[data-set-history-card] button')
    if (!toggle) throw new Error('no toggle')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(2)
  })
})
