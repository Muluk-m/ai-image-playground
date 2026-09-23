// @vitest-environment jsdom
import { PROJECT_META_VALUE_MAX_CHARS } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  decodeRecipe,
  encodeRecipe,
  type RegenRecipe,
  recipeSourcesPresent,
} from '../../../../features/canvas/lib/regenRecipe'

const base: RegenRecipe = {
  v: 1,
  kind: 'inpaint',
  prompt: '把水龙头换成金色',
  annotated: false,
  params: { n: 1 } as never,
  entries: [{ imageId: 'img-1', graphicIds: [] }],
}

/**
 * 配方是刷新之后「重新生成」唯一的依据。它要么完整存下来、要么根本不存——
 * 存半份会让重出拿着残缺的输入去生成，而用户在界面上看不出任何异常。
 */
describe('regen recipe', () => {
  it('round-trips through meta', () => {
    const encoded = encodeRecipe(base)
    expect(encoded).toBeDefined()
    expect(decodeRecipe(encoded)).toMatchObject({ kind: 'inpaint', prompt: base.prompt })
  })

  it('refuses to store a recipe that would not fit in element meta', () => {
    const huge: RegenRecipe = {
      ...base,
      strokes: [
        {
          tool: 'brush',
          width: 12,
          points: Array.from({ length: 20000 }, (_, i) => ({ x: i, y: i })),
        },
      ],
    }
    expect(encodeRecipe(huge)).toBeUndefined()
  })

  it('keeps a normal amount of painting well inside the limit', () => {
    const painted: RegenRecipe = {
      ...base,
      strokes: Array.from({ length: 8 }, () => ({
        tool: 'brush' as const,
        width: 24.44,
        points: Array.from({ length: 40 }, (_, i) => ({ x: i * 3.14159, y: i * 2.71828 })),
      })),
    }
    const encoded = encodeRecipe(painted)
    expect(encoded).toBeDefined()
    expect(encoded!.length).toBeLessThan(PROJECT_META_VALUE_MAX_CHARS)
  })

  it('rejects anything that is not a version 1 recipe', () => {
    expect(decodeRecipe(undefined)).toBeUndefined()
    expect(decodeRecipe('not json')).toBeUndefined()
    expect(decodeRecipe('{"v":2,"entries":[]}')).toBeUndefined()
  })

  it('reports a missing source element instead of silently dropping an input', () => {
    const doc = new CanvasDoc()
    const editor = new CanvasEditor(doc)
    const [imageId] = editor.placeImages([
      { dataUrl: 'data:image/png;base64,x', x: 0, y: 0, width: 10, height: 10 },
    ])

    expect(
      recipeSourcesPresent(editor, { ...base, entries: [{ imageId: imageId!, graphicIds: [] }] }),
    ).toBe(true)
    expect(recipeSourcesPresent(editor, base)).toBe(false)
  })
})
