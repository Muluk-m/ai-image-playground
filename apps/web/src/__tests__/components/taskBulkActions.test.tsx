// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import TaskBulkActions from '../../components/TaskBulkActions'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [],
    status: 'error',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ tasks: [], filterStatus: 'all', selectedTaskIds: [] })
})

it('「失败」筛选下全选只选网格里看得见的失败卡，不带上已取消的', () => {
  useStore.setState({
    tasks: [
      task('failed'),
      task('cancelled', { cancelled: true }),
      task('done', { status: 'done' }),
    ],
    platformGenerations: [],
    searchQuery: '',
    filterStatus: 'error',
    filterFavorite: false,
    selectedTaskIds: ['failed'],
  })
  act(() => root.render(<TaskBulkActions />))

  // 只选了一张失败卡就已经是「全选当前可见」。
  expect(host.querySelector('[aria-label="取消全选"]')).not.toBeNull()
  act(() => {
    host.querySelector<HTMLButtonElement>('[aria-label="取消全选"]')?.click()
  })
  expect(useStore.getState().selectedTaskIds).toEqual([])
  act(() => useStore.setState({ selectedTaskIds: ['done', 'cancelled'] }))
  act(() => {
    host.querySelector<HTMLButtonElement>('[aria-label="全选当前可见"]')?.click()
  })
  expect(useStore.getState().selectedTaskIds).toEqual(['failed'])
})
