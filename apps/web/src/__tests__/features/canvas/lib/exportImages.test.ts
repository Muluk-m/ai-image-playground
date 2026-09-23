import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc, type CanvasEl, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import {
  exportableElements,
  exportCanvasImages,
  safeFileName,
} from '../../../../features/canvas/lib/exportImages'

const downloaded: Array<{ blob: Blob; filename: string }> = []

vi.mock('../../../../lib/downloadImages', () => ({
  downloadBlob: (blob: Blob, filename: string) => downloaded.push({ blob, filename }),
}))

// 位图来源在真实实现里可能是 data URL，也可能是要回源的云媒体标识；这里只关心「取到 / 取不到」。
vi.mock('../../../../lib/canvasImage', () => ({
  dataUrlToBlob: async (source: string) => {
    if (source === 'broken') throw new Error('gone')
    return new Blob([source], { type: 'image/png' })
  },
}))

function image(id: string, overrides: Partial<ImageEl> = {}): ImageEl {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fileId: `file-${id}`,
    ...overrides,
  }
}

function docWith(elements: CanvasEl[], files: Record<string, string>): CanvasDoc {
  const doc = new CanvasDoc()
  doc.restore(elements, files)
  return doc
}

beforeEach(() => {
  downloaded.length = 0
})

describe('safeFileName', () => {
  it('strips path separators and control characters, and never returns an empty name', () => {
    expect(safeFileName('a/b:c*d?"<>|e')).toBe('a b c d e')
    expect(safeFileName('   ')).toBe('image')
    expect(safeFileName('.'.repeat(5))).toBe('image')
  })

  it('truncates names built from whole prompts', () => {
    expect(safeFileName('猫'.repeat(200))).toHaveLength(60)
  })
})

describe('exportableElements', () => {
  it('lists images with bitmaps in canvas order and leaves markup and empty files out', () => {
    const doc = docWith(
      [
        image('late', { createdAt: 200, x: 10 }),
        image('early', { createdAt: 100 }),
        image('missing', { createdAt: 50, fileId: 'nope' }),
        {
          id: 'note',
          type: 'text',
          x: 0,
          y: 0,
          text: 'hi',
          fontSize: 12,
          fill: '#000',
          width: 10,
          height: 10,
        },
      ],
      { 'file-late': 'late-bytes', 'file-early': 'early-bytes' },
    )
    expect(exportableElements(doc).map((el) => el.id)).toEqual(['early', 'late'])
  })

  it('keeps video nodes: their bytes come from the server, not the cover bitmap', () => {
    const doc = docWith(
      [image('clip', { fileId: 'poster', video: { taskId: 't', outputIndex: 0 } })],
      {},
    )
    expect(exportableElements(doc).map((el) => el.id)).toEqual(['clip'])
  })
})

describe('exportCanvasImages', () => {
  it('packs several items into one zip, numbered in canvas order, without name collisions', async () => {
    const doc = docWith(
      [image('a', { createdAt: 100, name: '橘猫' }), image('b', { createdAt: 200, name: '橘猫' })],
      { 'file-a': 'a-bytes', 'file-b': 'b-bytes' },
    )

    const result = await exportCanvasImages(doc, ['a', 'b'], { baseName: '猫猫项目' })

    expect(result).toEqual({ exported: 2, failed: 0 })
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0]!.filename).toBe('猫猫项目.zip')
    const entries = unzipSync(new Uint8Array(await downloaded[0]!.blob.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['01-橘猫.png', '02-橘猫.png'])
  })

  it('keeps one extension when the name already carries the imported file name', async () => {
    const doc = docWith([image('a', { meta: { filename: '浴缸.jpeg' } })], { 'file-a': 'a-bytes' })

    await exportCanvasImages(doc, ['a'])

    expect(downloaded[0]!.filename).toBe('浴缸.png')
  })

  it('downloads a single item directly instead of zipping it', async () => {
    const doc = docWith([image('a', { name: '橘猫' })], { 'file-a': 'a-bytes' })

    const result = await exportCanvasImages(doc, ['a'])

    expect(result).toEqual({ exported: 1, failed: 0 })
    expect(downloaded[0]!.filename).toBe('橘猫.png')
  })

  it('reports unreadable items and still exports the rest', async () => {
    const doc = docWith(
      [image('a', { createdAt: 100, name: '好的' }), image('b', { createdAt: 200, name: '坏的' })],
      { 'file-a': 'a-bytes', 'file-b': 'broken' },
    )

    const result = await exportCanvasImages(doc, ['a', 'b'])

    expect(result).toEqual({ exported: 1, failed: 1 })
    const entries = unzipSync(new Uint8Array(await downloaded[0]!.blob.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['01-好的.png'])
  })

  it('reports progress per item so the caller can show a counter', async () => {
    const doc = docWith([image('a', { createdAt: 1 }), image('b', { createdAt: 2 })], {
      'file-a': 'a-bytes',
      'file-b': 'b-bytes',
    })
    const seen: Array<[number, number]> = []

    await exportCanvasImages(doc, ['a', 'b'], {
      onProgress: (done, total) => seen.push([done, total]),
    })

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})
