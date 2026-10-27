import type { ManagedModel } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { modelState, modelSummary, sortModels } from '../../../features/models/model-state'

const model = (id: string, patch: Partial<ManagedModel> = {}): ManagedModel => ({
  id,
  label: id,
  kind: 'image',
  active: true,
  pause_reason: null,
  paused_at: null,
  ...patch,
})

const paused = { active: false, pause_reason: 'upstream_unavailable', paused_at: 1 } as const

describe('model state', () => {
  it('tells an automatic pause apart from a manual stop', () => {
    expect(modelState(model('a'))).toBe('active')
    expect(modelState(model('a', paused))).toBe('paused')
    expect(modelState(model('a', { active: false }))).toBe('inactive')
  })

  it('puts paused models first, then sorts by id', () => {
    const sorted = sortModels([model('c'), model('b', { active: false }), model('d', paused)])
    expect(sorted.map((entry) => entry.id)).toEqual(['d', 'b', 'c'])
  })

  it('counts each state and skips empty ones', () => {
    expect(modelSummary([model('a'), model('b'), model('c', paused)])).toBe('上架 2 · 自动暂停 1')
  })
})
