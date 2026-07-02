import { describe, expect, it, vi } from 'vitest'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { Box } from '../../../../features/canvas/lib/geometry'
import { rasterizeSelection } from '../../../../features/canvas/lib/rasterizeSelection'

function box(x: number, y: number, w: number, h: number): Box {
  return new Box(x, y, w, h)
}

interface ElementSpec {
  type: string
  /** 页面坐标包围盒 */
  box: Box
  /** 文字标注内容（type 为 text 时生效） */
  text?: string
}

/**
 * CanvasEditor 桩：rasterizeSelection 只用到查询接口 + toImage。
 * 占位框用 type 'generation-placeholder' 标记，isPlaceholder 据此判定。
 */
function makeEditor(opts: {
  selected: string[]
  elements: Record<string, ElementSpec>
  toImage?: ReturnType<typeof vi.fn>
}): CanvasEditor {
  const toElement = (id: string, spec: ElementSpec) => ({
    id,
    type: spec.type === 'generation-placeholder' ? 'rectangle' : spec.type,
    text: spec.text ?? '',
  })
  const isPlaceholderId = (id: string) => opts.elements[id]?.type === 'generation-placeholder'
  return {
    getSelectedIds: () => opts.selected,
    getElement: (id: string) => {
      const spec = opts.elements[id]
      return spec ? toElement(id, spec) : undefined
    },
    getElementPageBounds: (id: string) => opts.elements[id]?.box,
    getElements: () => Object.entries(opts.elements).map(([id, spec]) => toElement(id, spec)),
    isPlaceholder: (el: { id: string }) => isPlaceholderId(el.id),
    toImage:
      opts.toImage ??
      vi.fn(async (_ids: readonly string[], _opts?: unknown) => 'data:image/png;base64,x'),
  } as unknown as CanvasEditor
}

const mockToImage = () =>
  vi.fn(async (_ids: readonly string[], _opts?: unknown) => 'data:image/png;base64,x')

describe('rasterizeSelection', () => {
  it('纯多图（无标注）：每张图片各自独立栅格化（决策 5，不拼合）', async () => {
    const toImage = mockToImage()
    const editor = makeEditor({
      selected: ['img1', 'img2'],
      elements: {
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
      // 只选中图片，freedraw 未选中——但它压在图上，应自动纳入
      selected: ['img1'],
      elements: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        draw1: { type: 'freedraw', box: box(40, 40, 30, 30) },
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
      elements: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        // 圈与图重叠 → 箭头与圈重叠（不碰图）→ 文字与箭头重叠（更远）
        circle: { type: 'freedraw', box: box(80, 40, 40, 30) },
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
      elements: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        img2: { type: 'image', box: box(500, 0, 100, 100) },
        draw1: { type: 'freedraw', box: box(40, 40, 30, 30) }, // 只压 img1
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
      elements: {
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
      elements: {
        img1: { type: 'image', box: box(0, 0, 100, 100) },
        far: { type: 'freedraw', box: box(900, 900, 30, 30) },
      },
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
  })

  it('无选中元素 → null；纯标注无图片 → null', async () => {
    expect(await rasterizeSelection(makeEditor({ selected: [], elements: {} }))).toBeNull()
    expect(
      await rasterizeSelection(
        makeEditor({
          selected: ['draw1'],
          elements: { draw1: { type: 'freedraw', box: box(0, 0, 10, 10) } },
        }),
      ),
    ).toBeNull()
  })
})
