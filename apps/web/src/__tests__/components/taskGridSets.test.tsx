// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { openImageExport } from '../../features/image-export/store'
import { readLegacyProductJobs } from '../../lib/legacyProductHistory'

vi.mock('../../features/image-export/store', async (original) => ({
  ...(await original<object>()),
  openImageExport: vi.fn(),
}))

vi.mock('../../lib/legacyProductHistory', async (original) => ({
  ...(await original<object>()),
  readLegacyProductJobs: vi.fn(),
}))

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
    detailTaskId: null,
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  })
  vi.mocked(openImageExport).mockClear()
  vi.mocked(readLegacyProductJobs).mockResolvedValue([
    { id: 'set-1', name: '奶油浴缸', images: [] },
  ])
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

async function render() {
  await act(async () => root.render(<TaskGrid />))
}

function cardIds(): string[] {
  return [...document.querySelectorAll('.task-card-wrapper')].map(
    (node) => node.getAttribute('data-task-id') ?? '',
  )
}

describe('the history folded by set', () => {
  it('shows one card for a set instead of its separate tasks', async () => {
    useStore.setState({
      tasks: [
        task('a1', 5, { setId: 'set-1', shotId: 's1' }),
        task('loose', 4),
        task('a2', 3, { setId: 'set-1', shotId: 's2' }),
      ],
    })
    await render()

    expect(document.body.textContent).toContain('奶油浴缸')
    expect(document.body.textContent).toContain('完成 2/2')
    expect(cardIds()).toEqual(['loose'])
  })

  it('reveals the tasks of the set once it is expanded', async () => {
    useStore.setState({
      tasks: [
        task('a1', 5, { setId: 'set-1', shotId: 's1' }),
        task('a2', 3, { setId: 'set-1', shotId: 's2' }),
      ],
    })
    await render()

    const toggle = document.querySelector('button[aria-expanded="false"]')
    if (!toggle) throw new Error('no expand button')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(cardIds()).toEqual(['a1', 'a2'])
  })

  it('lists each failed image of a per-image batch with its reason and a retry', async () => {
    const batch = (shotId: string) => ({ setId: 'batch-1', shotId, kind: 'batch' as const })
    useStore.setState({
      tasks: [
        task('b1', 5, batch('1')),
        {
          ...task('b2', 5, batch('2')),
          status: 'error',
          error: '图片太大，上游拒绝了\n详情',
          inputImageIds: ['ref-2'],
        },
      ],
    })
    await render()

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('提示词 b1')
    expect(card?.textContent).toContain('逐张生成')
    expect(card?.textContent).toContain('完成 1/2')
    const failure = document.querySelector('[data-set-history-failure]')
    expect(failure?.textContent).toContain('第 2 张')
    expect(failure?.textContent).toContain('图片太大，上游拒绝了')
    expect(failure?.textContent).not.toContain('详情')
    expect(failure?.querySelector('button')?.textContent).toBe('重试')
  })

  it('counts running and queued images of a per-image batch separately', async () => {
    const batch = (shotId: string) => ({ setId: 'batch-2', shotId, kind: 'batch' as const })
    const running = (id: string, shotId: string, queued = false) => ({
      ...task(id, 5, batch(shotId)),
      status: 'running' as const,
      outputImages: [],
      ...(queued ? { batchQueued: true as const } : {}),
    })
    useStore.setState({
      tasks: [running('q1', '1'), running('q2', '2'), running('q3', '3', true)],
    })
    await render()

    const card = document.querySelector('[data-set-history-card]')
    expect(card?.textContent).toContain('完成 0/3 · 生成中 2 · 排队中 1')
    expect(document.querySelectorAll('[data-batch-tile="running"]')).toHaveLength(2)
    const queuedTile = document.querySelector('[data-batch-tile="queued"]')
    expect(queuedTile?.textContent).toBe('排队中')
  })

  describe('a finished per-image batch', () => {
    const batch = (shotId: string) => ({ setId: 'batch-3', shotId, kind: 'batch' as const })
    const finished = () =>
      useStore.setState({
        tasks: [
          { ...task('c1', 5, batch('1')), outputImages: ['img-1'] },
          { ...task('c2', 5, batch('2')), outputImages: ['img-2'] },
          { ...task('c3', 5, batch('3')), outputImages: ['img-3'] },
        ],
      })
    const click = (node: Element | null | undefined) => {
      if (!node) throw new Error('missing element')
      act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    const expand = () => click(document.querySelector('button[aria-expanded="false"]'))

    it('opens the image a thumbnail shows', async () => {
      finished()
      await render()

      click(document.querySelector('[aria-label="查看第 2 张"]'))

      expect(useStore.getState().detailTaskId).toBe('c2')
    })

    it('lists every image inside the card once expanded, each with its own download', async () => {
      finished()
      await render()
      expand()

      const items = [...document.querySelectorAll('[data-set-history-card] [data-batch-item]')]
      expect(items.map((item) => item.getAttribute('data-batch-item'))).toEqual(['c1', 'c2', 'c3'])
      expect(items.map((item) => item.textContent)).toEqual(['第 1 张', '第 2 张', '第 3 张'])
      // 不再把每张散成网格里的单张卡。
      expect(cardIds()).toEqual([])

      click(items[1]?.querySelector('[aria-label="下载第 2 张"]'))
      expect(openImageExport).toHaveBeenCalledTimes(1)
      const sources = vi.mocked(openImageExport).mock.calls[0]?.[0]
      expect(sources?.map((source) => source.id)).toEqual(['c2:img-2'])

      click(items[2]?.querySelector('[aria-label="查看第 3 张"]'))
      expect(useStore.getState().detailTaskId).toBe('c3')
    })

    it('downloads all images of the batch at once', async () => {
      finished()
      await render()
      expand()

      click(document.querySelector('[data-batch-download-all]'))

      const sources = vi.mocked(openImageExport).mock.calls[0]?.[0]
      expect(sources?.map((source) => source.id)).toEqual(['c1:img-1', 'c2:img-2', 'c3:img-3'])
    })

    it('keeps failed and cancelled shots openable as cards once expanded', async () => {
      useStore.setState({
        tasks: [
          { ...task('c1', 5, batch('1')), outputImages: ['img-1'] },
          { ...task('c2', 5, batch('2')), status: 'error', error: '内容不合规' },
          { ...task('c3', 5, batch('3')), status: 'error', error: '已取消', cancelled: true },
        ],
      })
      await render()
      expand()

      const items = [...document.querySelectorAll('[data-set-history-card] [data-batch-item]')]
      expect(items.map((item) => item.getAttribute('data-batch-item'))).toEqual(['c1'])
      // 失败、取消的那几张仍是作品卡，能点开详情看原因、复制诊断或删除。
      expect(cardIds()).toEqual(['c2', 'c3'])
    })
  })
})
