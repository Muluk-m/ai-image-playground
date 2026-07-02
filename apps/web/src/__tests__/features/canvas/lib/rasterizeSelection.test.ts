import type { Editor, TLShapeId } from 'tldraw'
import { describe, expect, it, vi } from 'vitest'

// rasterizeSelection 从 'tldraw' 取运行时值 Box.Common / renderPlaintextFromRichText；
// node 环境不加载真 tldraw，桩掉：Box.Common 返回首个 box，plaintext 直接取 richText.text。
vi.mock('tldraw', () => ({
  Box: { Common: (boxes: unknown[]) => boxes[0] },
  renderPlaintextFromRichText: (_editor: unknown, richText: { text?: string }) =>
    richText.text ?? '',
}))

import { rasterizeSelection } from '../../../../features/canvas/lib/rasterizeSelection'

interface ShapeSpec {
  type: string
  /** 文字标注内容（text shape）；桩里映射为 props.richText.text */
  text?: string
}

function makeEditor(opts: {
  selected: string[]
  shapes: Record<string, ShapeSpec>
  toImage?: ReturnType<typeof vi.fn>
}): Editor {
  const box = {
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    midX: 50,
    midY: 50,
  }
  return {
    getSelectedShapeIds: () => opts.selected as TLShapeId[],
    getShape: (id: string) => {
      const spec = opts.shapes[id]
      if (!spec) return undefined
      return { id, type: spec.type, props: spec.text ? { richText: { text: spec.text } } : {} }
    },
    getShapePageBounds: () => box,
    toImage:
      opts.toImage ??
      vi.fn(async (_ids: readonly string[]) => ({ blob: new Blob(['x'], { type: 'image/png' }) })),
  } as unknown as Editor
}

describe('rasterizeSelection', () => {
  it('纯多图（无标注）：每张图片各自独立栅格化（决策 5，不拼合）', async () => {
    const toImage = vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'img2'],
      shapes: { img1: { type: 'image' }, img2: { type: 'image' } },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
    expect(result?.annotationText).toBe('')
    expect(result?.dataUrls).toHaveLength(2)
    // 每次 toImage 只喂**单个** shape id（各自栅格化，绝不整选区拼一张）
    expect(toImage).toHaveBeenCalledTimes(2)
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
    expect(toImage.mock.calls[1][0]).toEqual(['img2'])
  })

  it('图片 + 图形标注（draw）：以图片包围盒为裁剪框合成单张', async () => {
    const toImage = vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'draw1'],
      shapes: { img1: { type: 'image' }, draw1: { type: 'draw' } },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.annotationText).toBe('')
    expect(result?.dataUrls).toHaveLength(1)
    expect(toImage).toHaveBeenCalledTimes(1)
    // 图片 + 图形标注一起，且带 bounds（裁到图片范围）
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'draw1'])
    expect(toImage.mock.calls[0][1]).toMatchObject({ bounds: expect.anything() })
  })

  it('图片 + 文字标注（text）：文字抽成 annotationText，不画进图', async () => {
    const toImage = vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'text1'],
      shapes: { img1: { type: 'image' }, text1: { type: 'text', text: '变成铃铛' } },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.annotationText).toBe('变成铃铛')
    // text shape 不进合成图：toImage 只喂图片
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
  })

  it('图片 + 圈 + 文字：圈进图、文字进 annotationText', async () => {
    const toImage = vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'draw1', 'text1'],
      shapes: {
        img1: { type: 'image' },
        draw1: { type: 'draw' },
        text1: { type: 'text', text: '变成铃铛' },
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.annotationText).toBe('变成铃铛')
    // 图形标注进图、文字不进图
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'draw1'])
  })

  it('无选中 shape → null', async () => {
    const editor = makeEditor({ selected: [], shapes: {} })
    expect(await rasterizeSelection(editor)).toBeNull()
  })

  it('纯标注无图片 → null（无图像基底，走文生图）', async () => {
    const editor = makeEditor({ selected: ['draw1'], shapes: { draw1: { type: 'draw' } } })
    expect(await rasterizeSelection(editor)).toBeNull()
  })
})
