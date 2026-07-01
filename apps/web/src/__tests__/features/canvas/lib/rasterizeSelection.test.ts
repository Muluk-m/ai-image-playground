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
    toImage: opts.toImage ?? vi.fn(async () => ({ blob: new Blob(['x'], { type: 'image/png' }) })),
  } as unknown as Editor
}

describe('rasterizeSelection', () => {
  it('多张图片各自独立栅格化（决策 5：不拼合），一图一 dataUrl', async () => {
    const toImage = vi.fn(async (_ids: readonly string[]) => ({
      blob: new Blob(['x'], { type: 'image/png' }),
    }))
    const editor = makeEditor({
      selected: ['img1', 'note1', 'img2'],
      types: { img1: 'image', note1: 'note', img2: 'image' },
      toImage,
    })

    const result = await rasterizeSelection(editor)

    expect(result).not.toBeNull()
    // 2 张图片 → 2 个独立输入；非图片 note1 被过滤
    expect(result?.dataUrls).toHaveLength(2)
    // 每次 toImage 只喂**单个** shape id（各自栅格化，绝不整选区拼一张）
    expect(toImage).toHaveBeenCalledTimes(2)
    expect(toImage.mock.calls[0][0]).toEqual(['img1'])
    expect(toImage.mock.calls[1][0]).toEqual(['img2'])
  })

  it('无选中 shape → null', async () => {
    const editor = makeEditor({ selected: [], types: {} })
    expect(await rasterizeSelection(editor)).toBeNull()
  })

  it('选区里只有非图片 shape → null（非图片不作为图像输入）', async () => {
    const editor = makeEditor({ selected: ['note1'], types: { note1: 'note' } })
    expect(await rasterizeSelection(editor)).toBeNull()
  })
})
