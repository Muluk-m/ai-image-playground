import { describe, expect, it } from 'vitest'
import { ALL_FILTER, filterVideoTasks, videoFeedFilters } from '../../../../features/video/lib/feed'
import { videoTask } from '../fixtures'

const TASKS = [
  videoTask({ id: 'done-old', prompt: '浴缸注水', createdAt: 100 }),
  videoTask({ id: 'done-new', prompt: '霓虹街道', createdAt: 300 }),
  videoTask({
    id: 'running',
    prompt: '沙漠日出',
    createdAt: 200,
    status: 'running',
    source: 'image',
    firstFrameImageId: 'img-1',
    model: 'agnes-video-2.5-flash',
  }),
]

describe('listing the feed filters', () => {
  it('counts what the feed actually holds', () => {
    expect(videoFeedFilters(TASKS)).toEqual([
      { id: 'all', label: '全部', count: 3 },
      { id: 'running', label: '生成中', count: 1 },
      { id: 'source:text', label: '文生', count: 2 },
      { id: 'source:image', label: '图生', count: 1 },
      { id: 'model:grok-imagine-video', label: 'Grok', count: 2 },
      { id: 'model:agnes-video-2.5-flash', label: 'Agnes 2.5 Flash', count: 1 },
    ])
  })

  it('drops filters nothing matches', () => {
    const ids = videoFeedFilters([videoTask()]).map((filter) => filter.id)

    expect(ids).toEqual(['all', 'source:text', 'model:grok-imagine-video'])
  })
})

describe('narrowing the feed', () => {
  it('puts anything still generating first, then newest', () => {
    const ids = filterVideoTasks(TASKS, ALL_FILTER, '').map((task) => task.id)

    expect(ids).toEqual(['running', 'done-new', 'done-old'])
  })

  it('matches the description case-insensitively', () => {
    const ids = filterVideoTasks(TASKS, ALL_FILTER, ' 霓虹 ').map((task) => task.id)

    expect(ids).toEqual(['done-new'])
  })

  it('keeps only what is still generating', () => {
    const ids = filterVideoTasks(TASKS, 'running', '').map((task) => task.id)

    expect(ids).toEqual(['running'])
  })

  it('filters by source and by model', () => {
    expect(filterVideoTasks(TASKS, 'source:image', '').map((task) => task.id)).toEqual(['running'])
    expect(filterVideoTasks(TASKS, 'model:grok-imagine-video', '').map((task) => task.id)).toEqual([
      'done-new',
      'done-old',
    ])
  })

  it('applies the search on top of the filter', () => {
    expect(filterVideoTasks(TASKS, 'source:text', '沙漠')).toEqual([])
  })
})
