import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TYPICAL_MS,
  estimatedProgressPercent,
  forgetGenerating,
  markGenerating,
  progressStartedAt,
  typicalDurationMs,
} from '../../lib/generationProgress'
import type { TaskRecord } from '../../types'

const done = (apiModel: string, elapsed: number) =>
  ({ status: 'done', apiModel, elapsed }) as unknown as TaskRecord

describe('estimatedProgressPercent', () => {
  it('rises monotonically, reaches 85% at the typical duration and never shows 100%', () => {
    const values = [0, 5_000, 20_000, 40_000, 80_000, 600_000].map((ms) =>
      estimatedProgressPercent(ms, 40_000),
    )
    expect(values[0]).toBe(0)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
    expect(values[3]).toBe(85)
    expect(values[5]).toBe(99)
  })
})

describe('typicalDurationMs', () => {
  it('uses the median of the latest finished tasks of the same model', () => {
    const tasks = [
      done('flare', 30_000),
      done('other', 90_000),
      done('flare', 34_000),
      done('flare', 50_000),
      { status: 'running', apiModel: 'flare', elapsed: null } as unknown as TaskRecord,
    ]
    expect(typicalDurationMs(tasks, 'flare')).toBe(34_000)
  })

  it('falls back to the default without samples', () => {
    expect(typicalDurationMs([done('other', 10_000)], 'flare')).toBe(DEFAULT_TYPICAL_MS)
  })
})

describe('progressStartedAt', () => {
  it('counts local tasks from their start', () => {
    expect(progressStartedAt({ id: 'l', createdAt: 1_000, batchStartedAt: 2_000 })).toBe(2_000)
    expect(progressStartedAt({ id: 'l2', createdAt: 1_000 })).toBe(1_000)
  })

  it('counts platform tasks only from the first time they are seen generating', () => {
    const task = { id: 'q', createdAt: 1_000, queuePhase: 'generating' as const }
    expect(progressStartedAt(task)).toBeNull()
    markGenerating(task, 60_000)
    markGenerating(task, 70_000)
    expect(progressStartedAt(task)).toBe(60_000)
    forgetGenerating('q')
    expect(progressStartedAt(task)).toBeNull()
  })

  it('treats legacy platform tasks without a phase as queued', () => {
    const legacy = { id: 'old', createdAt: 1_000, platformTask: true as const }
    expect(progressStartedAt(legacy)).toBeNull()
  })
})
