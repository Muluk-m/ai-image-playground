import { describe, expect, it } from 'vitest'
import { createCreationDraft, creationDraftReducer } from '../../../components/creation/draft'
import { reviewCatalog } from '../../../features/creation-review/fixtures'

describe('creation draft continuity', () => {
  it('retains shared content and references across modes while restoring each type settings', () => {
    let state = createCreationDraft(reviewCatalog)
    state = creationDraftReducer(state, { type: 'text', text: 'Keep this creative brief' })
    state = creationDraftReducer(state, {
      type: 'references',
      references: [{ id: 'portrait', name: 'Portrait', kind: 'image', src: '/portrait.webp' }],
    })
    state = creationDraftReducer(state, { type: 'model', model: reviewCatalog.image[1] })
    state = creationDraftReducer(state, { type: 'parameter', id: 'ratio', value: '9:16' })
    state = creationDraftReducer(state, { type: 'mode', mode: 'video' })
    state = creationDraftReducer(state, { type: 'parameter', id: 'duration', value: '15 秒' })
    state = creationDraftReducer(state, { type: 'mode', mode: 'agent' })
    state = creationDraftReducer(state, { type: 'parameter', id: 'strategy', value: '先规划' })
    state = creationDraftReducer(state, { type: 'mode', mode: 'image' })
    expect(state.text).toBe('Keep this creative brief')
    expect(state.references.map((r) => r.id)).toEqual(['portrait'])
    expect(state.selections.image.model).toBe('gemini-3.1-flash-image')
    expect(state.selections.image.values.ratio).toBe('9:16')
    state = creationDraftReducer(state, { type: 'mode', mode: 'video' })
    expect(state.selections.video.values.duration).toBe('15 秒')
    expect(state.selections.agent.values.strategy).toBe('先规划')
  })
  it('changes model-specific parameters without carrying unsupported options to the new model', () => {
    let state = createCreationDraft(reviewCatalog)
    state = creationDraftReducer(state, { type: 'model', model: reviewCatalog.image[1] })
    expect(state.selections.image.values).not.toHaveProperty('quality')
    expect(state.selections.image.values.resolution).toBe('2K')
    expect(state.selections.video.model).toBe(reviewCatalog.video[0].id)
  })
})
