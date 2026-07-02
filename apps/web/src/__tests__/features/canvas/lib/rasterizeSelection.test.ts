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

/** AABB 碰撞的 Box 桩（真 Box.collides 的最小等价实现）。 */
function box(x: number, y: number, w: number, h: number) {
  return {
    x,
    y,
    w,
    h,
    minX: x,
    minY: y,
    maxX: x + w,
    maxY: y + h,
    midX: x + w / 2,
    midY: y + h / 2,
    collides(b: { minX: number; minY: number; maxX: number; maxY: number }) {
      return !(b.minX > x + w || b.maxX < x || b.minY > y + h || b.maxY < y)
    },
  }
}

interface ShapeSpec {
  type: string
  /** 页面坐标包围盒 */
  box: ReturnType<typeof box>
  /** 文字标注内容；桩里映射为 props.richText.text */
  text?: string
}

function makeEditor(opts: {
  selected: string[]
  shapes: Record<string, ShapeSpec>
  toImage?: ReturnType<typeof vi.fn>
}): Editor {
  return {
    getSelectedShapeIds: () => opts.selected as TLShapeId[],
    getShape: (id: string) => {
      const spec = opts.shapes[id]
      if (!spec) return undefined
      return { id, type: spec.type, props: spec.text ? { richText: { text: spec.text } } : {} }
    },
    getShapePageBounds: (id: string) => opts.shapes[id]?.box,
    getCurrentPageShapes: () =>
      Object.entries(opts.shapes).map(([id, spec]) => ({
        id,
        type: spec.type,
        props: spec.text ? { richText: { text: spec.text } } : {},
      })),
    toImage:
      opts.toImage ??
      vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
        blob: new Blob(['x'], { type: 'image/png' }),
      })),
  } as unknown as Editor
}

const mockToImage = () =>
  vi.fn(async (_ids: readonly string[], _opts?: unknown) => ({
    blob: new Blob(['x'], { type: 'image/png' }),
  }))

describe('rasterizeSelection', () => {
  it('纯多图（无标注）：每张图片各自独立栅格化（决策 5，不拼合）', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      selected: ['img1', 'img2'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        img2: { type: 'image', box: box(500, 0, 100, 100) },
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
    expect(result?.dataUrls).toHaveLength(2)
    expect(toImage).toHaveBeenCalledTimes(2)
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
    expect(toImage.mock.calls[1][0]).toEqual(['img2'])
  })

  it('标注自动跟随：只选中图片，画在图上的圈也被带上（合成裁到该图范围）', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      // 只选中图片，draw 未选中——但它压在图上，应自动纳入
      selected: ['img1'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        draw1: { type: 'draw', box: box(40, 40, 30, 30) },
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.dataUrls).toHaveLength(1)
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'draw1'])
    expect(toImage.mock.calls[0][1]).toMatchObject({ bounds: expect.anything() })
  })

  it('传递重叠成簇：圈压图上、箭头接圈、文字接箭头——文字进 prompt', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      selected: ['img1'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        // 圈与图重叠 → 箭头与圈重叠（不碰图）→ 文字与箭头重叠（更远）
        circle: { type: 'draw', box: box(80, 40, 40, 30) },
        arrow: { type: 'arrow', box: box(115, 45, 60, 10) },
        label: { type: 'text', box: box(170, 40, 80, 20), text: '变成钢笔' },
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.annotationText).toBe('变成钢笔')
    // 压在图上的圈随图合成；箭头/文字在图片范围外（裁剪后不可见），不入图
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'circle'])
  })

  it('多图 + 单图标注：被标注的图合成、干净的图直出（不拼合）', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      selected: ['img1', 'img2'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        img2: { type: 'image', box: box(500, 0, 100, 100) },
        draw1: { type: 'draw', box: box(40, 40, 30, 30) }, // 只压 img1
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    expect(result?.dataUrls).toHaveLength(2)
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'draw1'])
    expect(toImage.mock.calls[1][0]).toEqual(['img2'])
  })

  it('生成占位框不算标注', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      selected: ['img1'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        ph1: { type: 'generation-placeholder', box: box(50, 50, 100, 100) },
      },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
  })

  it('远处无关的标注不被卷入', async () => {
    const editor = makeEditor({
      selected: ['img1'],
      shapes: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        far: { type: 'draw', box: box(900, 900, 30, 30) },
      },
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
  })

  it('无选中 shape → null；纯标注无图片 → null', async () => {
    expect(await rasterizeSelection(makeEditor({ selected: [], shapes: {} }))).toBeNull()
    expect(
      await rasterizeSelection(
        makeEditor({
          selected: ['draw1'],
          shapes: { draw1: { type: 'draw', box: box(0, 0, 10, 10) } },
        }),
      ),
    ).toBeNull()
  })
})
