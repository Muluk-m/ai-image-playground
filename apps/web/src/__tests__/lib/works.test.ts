import type { GenerationSummary } from '@image-playground/shared'
import { expect, it } from 'vitest'
import { RATIO_MAX, RATIO_MIN } from '../../features/inspiration/lib/masonry'
import {
  matchesWorksFilter,
  type WorkSource,
  workProjectId,
  workRatio,
  workSource,
  worksCounts,
} from '../../lib/works'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

type Row = { record: Pick<GenerationSummary, 'source'> }

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [`${id}-out`],
    status: 'done',
    error: null,
    createdAt: 1000,
    finishedAt: 1000,
    elapsed: 1,
    ...patch,
  }
}

const studio: Row = { record: { source: { kind: 'studio' } } }
const agent = (projectId: string | null): Row => ({
  record: {
    source: { kind: 'agent', conversationId: 'c', turnId: 't', projectId },
  },
})
const legacy: Row = { record: { source: null } }

it('来源按平台记录认：本机任务都是快速生成，历史上没记来源的只算进「全部」', () => {
  const rows = new Map<string, Row>([
    ['a', agent('project-1')],
    ['s', studio],
    ['old', legacy],
  ])
  expect(workSource(task('a', { remoteOnly: true }), rows)).toBe('agent')
  expect(workSource(task('local', { bffRequestId: 's' }), rows)).toBe('studio')
  expect(workSource(task('old', { remoteOnly: true }), rows)).toBe('unknown')
  expect(workSource(task('fresh'), rows)).toBe('studio')
  expect(workProjectId(task('a', { remoteOnly: true }), rows)).toBe('project-1')
  expect(workProjectId(task('local', { bffRequestId: 's' }), rows)).toBeNull()
  expect(matchesWorksFilter('unknown', 'all')).toBe(true)
  expect(matchesWorksFilter('unknown', 'studio')).toBe(false)
  expect(matchesWorksFilter('agent', 'agent')).toBe(true)
})

it('瀑布卡的比例：实测像素优先，再看请求尺寸与 Gemini 比例，并夹在上下限内', () => {
  expect(workRatio(task('m', { measuredSize: '1024x1536' }))).toBe(1.5)
  expect(
    workRatio(
      task('a', {
        actualParams: { size: '1536x1024' },
        params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      }),
    ),
  ).toBeCloseTo(1024 / 1536)
  expect(workRatio(task('r', { params: { ...DEFAULT_PARAMS, size: '1024x1024' } }))).toBe(1)
  expect(
    workRatio(
      task('g', { params: { ...DEFAULT_PARAMS, size: 'auto', gemini_aspect_ratio: '9:16' } }),
    ),
  ).toBeCloseTo(16 / 9)
  expect(workRatio(task('tall', { measuredSize: '100x1000' }))).toBe(RATIO_MAX)
  expect(workRatio(task('wide', { measuredSize: '1000x100' }))).toBe(RATIO_MIN)
  expect(workRatio(task('none', { params: { ...DEFAULT_PARAMS, size: 'auto' } }))).toBe(0.75)
})

it('没有服务端总数时按手上的时间线数', () => {
  const rows = new Map<string, Row>([
    ['a', agent(null)],
    ['old', legacy],
  ])
  const counts = worksCounts(
    [task('a', { remoteOnly: true }), task('old', { remoteOnly: true }), task('local')],
    rows,
    null,
  )
  expect(counts).toEqual({ all: 3, studio: 1, agent: 1 })
})

it('页签数字以服务端总数为准：只翻了一页也显示全部，刚删的减掉、新出的加上', () => {
  const known = new Map<string, WorkSource>([
    ['s1', 'studio'],
    ['a1', 'agent'],
    ['gone', 'agent'],
  ])
  const rows = new Map<string, Row>([
    ['s1', studio],
    ['a1', agent('p')],
  ])
  const snapshot = { totals: { all: 1000, studio: 600, agent: 380 }, known, at: 5000 }
  const tasks = [
    task('s1', { remoteOnly: true }),
    task('a1', { remoteOnly: true }),
    // 快照之后才发起的本机任务：还不在总数里。
    task('new', { createdAt: 6000 }),
    // 快照之前已经交给平台、还没翻到它那一页：总数里已经有了。
    task('local-old', { bffRequestId: 'server-old', createdAt: 4000 }),
  ]

  expect(worksCounts(tasks, rows, snapshot)).toEqual({ all: 1000, studio: 601, agent: 379 })
})

it('本机任务压住同一条平台记录时不重复计数', () => {
  const snapshot = {
    totals: { all: 10, studio: 10, agent: 0 },
    known: new Map<string, WorkSource>([['server-1', 'studio']]),
    at: 5000,
  }
  const tasks = [task('local-1', { bffRequestId: 'server-1', createdAt: 6000 })]
  expect(worksCounts(tasks, new Map([['server-1', studio]]), snapshot)).toEqual({
    all: 10,
    studio: 10,
    agent: 0,
  })
})
