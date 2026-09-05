// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { useRemixStore } from '../../features/remix/store'
import { useStore } from '../../store'
import type { TaskOrigin, TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function task(id: string, createdAt: number, origin?: TaskOrigin): TaskRecord {
  return {
    id,
    prompt: `提示词 ${id}`,
    params: { n: 1 } as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt,
    finishedAt: createdAt,
    elapsed: 1,
    ...(origin ? { origin } : {}),
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({
    tasks: [],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  })
  useRemixStore.setState({
    loadSets: vi.fn().mockResolvedValue(undefined),
    sets: [
      {
        id: 'set-1',
        name: '奶油浴缸',
        source: { sourceImageIds: ['i1'] },
        productAssets: [],
        settings: {
          platform: 'amazon',
          language: 'zh',
          level: 'high',
          product: { name: '', features: '', mainColor: '', forbiddenColors: [] },
        },
        shots: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
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
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(<TaskGrid />))
}

function cardIds(): string[] {
  return [...document.querySelectorAll('.task-card-wrapper')].map(
    (node) => node.getAttribute('data-task-id') ?? '',
  )
}

describe('the history folded by set', () => {
  it('shows one card for a set instead of its separate tasks', () => {
    useStore.setState({
      tasks: [
        task('a1', 5, { setId: 'set-1', shotId: 's1' }),
        task('loose', 4),
        task('a2', 3, { setId: 'set-1', shotId: 's2' }),
      ],
    })
    render()

    expect(document.body.textContent).toContain('奶油浴缸')
    expect(document.body.textContent).toContain('完成 2/2')
    expect(cardIds()).toEqual(['loose'])
  })

  it('reveals the tasks of the set once it is expanded', () => {
    useStore.setState({
      tasks: [
        task('a1', 5, { setId: 'set-1', shotId: 's1' }),
        task('a2', 3, { setId: 'set-1', shotId: 's2' }),
      ],
    })
    render()

    const toggle = document.querySelector('button[aria-expanded="false"]')
    if (!toggle) throw new Error('no expand button')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(cardIds()).toEqual(['a1', 'a2'])
  })
})
