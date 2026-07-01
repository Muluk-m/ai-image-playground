import type { Editor, TLShapeId } from 'tldraw'
import { describe, expect, it, vi } from 'vitest'
import { rasterizeSelection } from '../../../../features/canvas/lib/rasterizeSelection'

// rasterizeSelection 走 bytesToDataUrl（chunked btoa，node 原生可用），无需 DOM FileReader 桩。

function makeEditor(opts: {
  selected: string[]
  types: Record<string, string>
  toImage?: ReturnType<typeof vi.fn>
}): Editor {
  return {
    getSelectedShapeIds: () => opts.selected as TLShapeId[],
    getSelectionPageBounds: () => ({ maxX: 100, midX: 50, midY: 50, x: 0, y: 0, w: 100, h: 100 }),
    getShape: (id: string) => (opts.types[id] ? { type: opts.types[id] } : undefined),
    toImage:
      opts.toImage ??
      vi.fn(async (_ids: readonly string[]) => ({ blob: new Blob(['x'], { type: 'image/png' }) })),
  } as unknown as Editor
}

describe('rasterizeSelection', () => {
  it('纯多图（无标注）：每张图片各自独立栅格化（决策 5，不拼合）', async () => {
    const toImage = vi.fn(async (_ids: readonly string[]) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'img2'],
      types: { img1: 'image', img2: 'image' },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(false)
    expect(result?.dataUrls).toHaveLength(2)
    // 每次 toImage 只喂**单个** shape id（各自栅格化，绝不整选区拼一张）
    expect(toImage).toHaveBeenCalledTimes(2)
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
    expect(toImage.mock.calls[1][0]).toEqual(['img2'])
  })

  it('图片 + 手绘标注：合成为单张参考图，annotated=true', async () => {
    const toImage = vi.fn(async (_ids: readonly string[]) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'draw1'],
      types: { img1: 'image', draw1: 'draw' },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result?.annotated).toBe(true)
    // 合成模式：单张 dataUrl，且 toImage 一次性喂**全部选中 ids**（图片+标注一起）
    expect(result?.dataUrls).toHaveLength(1)
    expect(toImage).toHaveBeenCalledTimes(1)
    expect(toImage.mock.calls[0][0]).toEqual(['img1', 'draw1'])
  })

  it('无选中 shape → null', async () => {
    const editor = makeEditor({ selected: [], types: {} })
    expect(await rasterizeSelection(editor)).toBeNull()
  })

  it('纯标注无图片 → null（无图像基底，走文生图）', async () => {
    const editor = makeEditor({ selected: ['draw1'], types: { draw1: 'draw' } })
    expect(await rasterizeSelection(editor)).toBeNull()
  })
})
