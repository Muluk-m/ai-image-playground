import { describe, expect, it } from 'bun:test'
import {
  billedStageQuantity,
  parseCompleteStageVideoDraft,
  resolveStageImageExecution,
  resolveStageVideoExecution,
  stageExecutionSpecsMatch,
} from '../stage-execution'
import { VIDEO_MODEL_SUPPORT } from '../video-presets'

const grok = VIDEO_MODEL_SUPPORT['grok-imagine-video']!

describe('resolveStageVideoExecution', () => {
  it('drops an incomplete saved draft and uses the whole workbench draft', () => {
    expect(
      parseCompleteStageVideoDraft(JSON.stringify({ model: 'grok-imagine-video', duration: 15 })),
    ).toBeUndefined()
    const resolved = resolveStageVideoExecution({
      meta: { nodeVideoDraft: JSON.stringify({ model: 'grok-imagine-video', duration: 15 }) },
      references: [],
      globalDraft: {
        model: 'grok-imagine-video',
        duration: 8,
        resolution: '1080p',
        aspectRatio: '16:9',
      },
      options: [{ modelId: 'grok-imagine-video', support: grok }],
    })
    expect(resolved.spec).toEqual({ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1 })
    expect(resolved.draft.resolution).toBe('720p')
  })

  it('narrows 1080p to the reference-mode cap when the node does not name a mode', () => {
    const resolved = resolveStageVideoExecution({
      meta: {
        nodeVideoDraft: JSON.stringify({
          model: 'grok-imagine-video',
          duration: 8,
          resolution: '1080p',
          aspectRatio: '16:9',
        }),
      },
      references: [],
      globalDraft: {
        model: 'grok-imagine-video',
        duration: 5,
        resolution: '720p',
        aspectRatio: '16:9',
      },
      options: [{ modelId: 'grok-imagine-video', support: grok }],
    })
    expect(resolved.mode).toBe('reference')
    expect(resolved.spec).toEqual({ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1 })
  })

  it('keeps 1080p for an explicit text mode and ceils an unknown model', () => {
    const text = resolveStageVideoExecution({
      meta: {
        nodeVideoMode: 'text',
        nodeVideoDraft: JSON.stringify({
          model: 'grok-imagine-video',
          duration: 8,
          resolution: '1080p',
          aspectRatio: '16:9',
        }),
      },
      references: [],
      globalDraft: {
        model: 'grok-imagine-video',
        duration: 5,
        resolution: '720p',
        aspectRatio: '16:9',
      },
      options: [{ modelId: 'grok-imagine-video', support: grok }],
    })
    expect(text.spec).toEqual({ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1.6 })
    const unknown = resolveStageVideoExecution({
      meta: {},
      references: [],
      globalDraft: {
        model: 'video-fixture',
        duration: 1.9,
        resolution: '4k',
        aspectRatio: '16:9',
      },
      options: [],
    })
    expect(unknown.spec).toEqual({ model: 'video-fixture', quantity: 2, unitMultiplier: 1 })
  })
})

describe('stage execution quantity', () => {
  it('ceils once and treats an empty snapshot model as not yet locked', () => {
    expect(billedStageQuantity(1.2)).toBe(2)
    expect(billedStageQuantity(2)).toBe(2)
    expect(
      stageExecutionSpecsMatch(
        [{ nodeId: 'a', model: 'next', quantity: 2, unitMultiplier: 1 }],
        [{ nodeId: 'a', model: 'previous', quantity: 1.2, unitMultiplier: 1 }],
      ),
    ).toBe(false)
    expect(
      stageExecutionSpecsMatch(
        [{ nodeId: 'a', model: 'workbench', quantity: 1.2, unitMultiplier: 1 }],
        [{ nodeId: 'a', model: '', quantity: 2, unitMultiplier: 1 }],
      ),
    ).toBe(true)
  })

  it('prices an image with the workbench model and a single storyboard frame', () => {
    expect(
      resolveStageImageExecution({ model: ' workbench-image ', count: 4, storyboardRole: 'frame' }),
    ).toEqual({ model: 'workbench-image', quantity: 1, unitMultiplier: 1 })
    expect(resolveStageImageExecution({ model: '' })).toBeUndefined()
  })
})
