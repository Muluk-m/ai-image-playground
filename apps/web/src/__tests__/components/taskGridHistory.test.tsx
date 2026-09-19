// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { readLegacyProductJobs, readLegacyStoryboardTitles } from '../../lib/legacyProductHistory'

vi.mock('../../lib/legacyProductHistory', async (original) => ({
  ...(await original<object>()),
  readLegacyProductJobs: vi.fn(),
  readLegacyStoryboardTitles: vi.fn(),
}))

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
  vi.mocked(readLegacyProductJobs).mockResolvedValue([
    {
      id: 'job-1',
      name: '折叠浴缸',
      images: [
        { imageId: 'img-1', versions: [{ mode: 'background' }, { mode: 'replace-product' }] },
      ],
    },
  ])
  vi.mocked(readLegacyStoryboardTitles).mockResolvedValue(new Map())
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
  it('shows one card named after the job instead of every task', async () => {
    await act(async () => root.render(<TaskGrid />))

    const cards = document.querySelectorAll('[data-set-history-card]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('折叠浴缸')
    expect(cards[0].textContent).toContain('完成 1/2')
    expect(cards[0].textContent).toContain('失败 1')
    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(0)
  })

  it('tags the card with each action the job ran', async () => {
    await act(async () => root.render(<TaskGrid />))

    const tags = document.querySelectorAll('[data-set-history-card] [data-set-history-action]')
    expect([...tags].map((tag) => tag.textContent)).toEqual(['换背景', '换产品'])
  })

  it('falls back to a plain name once the job record is gone', async () => {
    vi.mocked(readLegacyProductJobs).mockResolvedValue([])
    await act(async () => root.render(<TaskGrid />))

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('商品图任务')
    expect(card?.querySelectorAll('[data-set-history-action]')).toHaveLength(0)
  })

  it('names a storyboard set after the storyboard', async () => {
    useStore.setState({ tasks: [storyboardTask('task-3'), storyboardTask('task-4')] })
    vi.mocked(readLegacyStoryboardTitles).mockResolvedValue(new Map([['board-1', '夏日冰饮']]))
    await act(async () => root.render(<TaskGrid />))

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('夏日冰饮')
  })

  it('lets the card open to its tasks', async () => {
    await act(async () => root.render(<TaskGrid />))

    const toggle = document.querySelector('[data-set-history-card] button')
    if (!toggle) throw new Error('no toggle')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(2)
  })
})
