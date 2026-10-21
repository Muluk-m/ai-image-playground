import { describe, expect, it } from 'bun:test'
import {
  billedStageQuantity,
  parseCompleteStageVideoDraft,
  resolveStageImageExecution,
  resolveStageVideoExecution,
  stageExecutionBinding,
  stageExecutionBindingMatches,
  stageExecutionSpecsMatch,
  stageSubmittedFileIds,
  stageSubmittedInputCount,
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
    expect(
      stageExecutionSpecsMatch(
        [
          { nodeId: 'a', model: 'same', quantity: 1, unitMultiplier: 1 },
          { nodeId: 'a', model: 'same', quantity: 1, unitMultiplier: 1 },
        ],
        [
          { nodeId: 'a', model: 'same', quantity: 1, unitMultiplier: 1 },
          { nodeId: 'b', model: 'same', quantity: 1, unitMultiplier: 1 },
        ],
      ),
    ).toBe(false)
  })

  it('prices an image with the workbench model and a single storyboard frame', () => {
    expect(
      resolveStageImageExecution({ model: ' workbench-image ', count: 4, storyboardRole: 'frame' }),
    ).toEqual({ model: 'workbench-image', quantity: 1, unitMultiplier: 1 })
    expect(resolveStageImageExecution({ model: '' })).toBeUndefined()
  })
})

describe('stage execution binding', () => {
  it('freezes the node prompt together with upstream text and rejects a different submission', () => {
    const text = {
      id: 't',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      z: 0,
      data: { text: '上文', fontSize: 16, fill: '#000' },
    }
    const image = {
      id: 'a',
      type: 'image' as const,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      z: 1,
      data: { meta: { nodePrompt: '嫩芽' } },
    }
    const binding = stageExecutionBinding({
      node: image,
      nodes: [text, image],
      edges: [{ source: 't', target: 'a' }],
      authorizedIds: new Set(['a']),
    })
    expect(binding).toEqual({ nodeId: 'a', kind: 'image', prompt: '上文\n嫩芽', inputCount: 0 })
    expect(stageExecutionBindingMatches(binding, { prompt: '嫩芽', inputCount: 0 })).toBe(false)
    expect(stageExecutionBindingMatches(binding, { prompt: '上文\n嫩芽', inputCount: 1 })).toBe(
      false,
    )
    expect(
      stageExecutionBindingMatches(binding, {
        prompt: '上文\n嫩芽',
        inputCount: 0,
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' },
      }),
    ).toBe(false)
    expect(stageExecutionBindingMatches(binding, { prompt: '上文\n嫩芽', inputCount: 0 })).toBe(
      true,
    )
  })

  it('counts image inputs the way the queue submits them and keeps video slots', () => {
    const shared = [
      { id: 'a', kind: 'image' as const, fileId: 'same' },
      { id: 'b', kind: 'image' as const, fileId: 'same' },
      { id: 'c', kind: 'image' as const, fileId: 'other' },
    ]
    const authorized = new Set(['a', 'b'])
    expect(stageSubmittedInputCount(shared, authorized, 'image')).toBe(3)
    expect(stageSubmittedFileIds(shared, authorized, 'image')).toEqual(['same', 'same', 'other'])
    expect(stageSubmittedInputCount(shared, new Set(), 'image')).toBe(2)
    expect(stageSubmittedFileIds(shared, new Set(), 'image')).toEqual(['same', 'other'])
    expect(stageSubmittedInputCount(shared, authorized, 'video')).toBe(3)
    expect(
      stageExecutionBindingMatches(
        {
          nodeId: 'v',
          kind: 'video',
          prompt: '嫩芽',
          inputCount: 0,
          video: { durationSeconds: 2, resolution: '720p', aspectRatio: '16:9' },
        },
        {
          prompt: '嫩芽',
          inputCount: 0,
          video: { durationSeconds: 1.9, resolution: '720p', aspectRatio: '16:9' },
        },
      ),
    ).toBe(false)
  })
})
