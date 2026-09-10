import { describe, expect, it } from 'vitest'
import {
  buildWorkflowPrompt,
  kitSpecs,
  workflowParams,
} from '../../../../features/productShots/workflows/plan'
import { DEFAULT_PARAMS } from '../../../../types'

describe('product image workflow requests', () => {
  it('creates one independent request for every requested size and language', () => {
    const specs = kitSpecs(['square', 'portrait'], ['zh', 'en'], { zh: '慢下来', en: 'Slow down' })
    expect(specs.map((s) => [s.format, s.language, s.title])).toEqual([
      ['square', 'zh', '慢下来'],
      ['square', 'en', 'Slow down'],
      ['portrait', 'zh', '慢下来'],
      ['portrait', 'en', 'Slow down'],
    ])
    expect(workflowParams(DEFAULT_PARAMS, specs[2]).size).toBe('1024x1536')
    expect(workflowParams(DEFAULT_PARAMS, specs[2]).n).toBe(1)
  })
  it('keeps local changes explicit and rejects an empty edit region', () => {
    expect(
      buildWorkflowPrompt({
        kind: 'edit',
        instruction: '去掉绿植',
        box: { x: 0.6, y: 0.1, w: 0.3, h: 0.7 },
      }),
    ).toContain('去掉绿植')
    expect(() =>
      buildWorkflowPrompt({
        kind: 'edit',
        instruction: '去掉绿植',
        box: { x: 0, y: 0, w: 0, h: 0 },
      }),
    ).toThrow()
  })
  it('uses a single high quality output for refinement and medium quality for drafts', () => {
    expect(
      workflowParams(
        { ...DEFAULT_PARAMS, n: 3 },
        { kind: 'refine', instruction: '', size: '1536x1024' },
      ),
    ).toMatchObject({ n: 1, quality: 'high', size: '1536x1024' })
    expect(
      workflowParams(DEFAULT_PARAMS, {
        kind: 'draft',
        direction: '自然日光',
        instruction: '白色浴缸',
      }).quality,
    ).toBe('medium')
  })
})
