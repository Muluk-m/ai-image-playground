// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  type LegacyCanvasElement,
  moveCanvasNodes,
  readCanvasDocument,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import { openNodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'

const legacy: LegacyCanvasElement[] = [
  {
    id: 'img',
    type: 'image',
    fileId: 'file_1',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    rotation: 0,
  },
  { id: 'arrow', type: 'arrow', points: [0, 0, 50, 50], stroke: '#ef4444', strokeWidth: 12 },
]

it('converts the legacy scene once and keeps later edits across reopen', async () => {
  const first = await openNodeCanvasDocument('scene-a', () => legacy)
  expect(readCanvasDocument(first.doc).nodes.map((node) => node.id)).toEqual(['img'])
  moveCanvasNodes(first.doc, [{ id: 'img', x: 99, y: 88 }], first.origin)
  await first.destroy()

  const second = await openNodeCanvasDocument('scene-a', () => legacy)
  const node = readCanvasDocument(second.doc).nodes[0]!
  expect([node.x, node.y]).toEqual([99, 88])
  expect(readCanvasDocument(second.doc).annotations.map((one) => one.id)).toEqual(['arrow'])
  await second.destroy()
})

it('keeps projects apart', async () => {
  const one = await openNodeCanvasDocument('scene-b', () => legacy)
  const other = await openNodeCanvasDocument('scene-c', () => [])
  expect(readCanvasDocument(other.doc).nodes).toEqual([])
  await one.destroy()
  await other.destroy()
})

it('undoes the device user moves but not the conversion', async () => {
  const canvas = await openNodeCanvasDocument('scene-d', () => legacy)
  moveCanvasNodes(canvas.doc, [{ id: 'img', x: 1, y: 1 }], canvas.origin)
  canvas.undo.undo()
  canvas.undo.undo()
  const node = readCanvasDocument(canvas.doc).nodes[0]!
  expect([node.x, node.y]).toEqual([10, 20])
  await canvas.destroy()
})

it('elects one migration snapshot across concurrent opens and commits it before returning', async () => {
  let imports = 0
  const opened = await Promise.all(
    ['old', 'new'].map((id) =>
      openNodeCanvasDocument('concurrent-migration', () => {
        imports += 1
        return [{ ...legacy[0]!, id }]
      }),
    ),
  )
  try {
    expect(imports).toBe(1)
    expect(readCanvasDocument(opened[0]!.doc)).toEqual(readCanvasDocument(opened[1]!.doc))
    const reopened = await openNodeCanvasDocument('concurrent-migration', () => {
      throw new Error('A committed migration must not consult the legacy snapshot')
    })
    try {
      expect(readCanvasDocument(reopened.doc)).toEqual(readCanvasDocument(opened[0]!.doc))
    } finally {
      await reopened.destroy()
    }
  } finally {
    await Promise.all(opened.map((canvas) => canvas.destroy()))
  }
})

it('rolls back a failed migration so another open can retry', async () => {
  await expect(
    openNodeCanvasDocument('failed-migration', () => {
      throw new Error('legacy read failed')
    }),
  ).rejects.toThrow('legacy read failed')
  const recovered = await openNodeCanvasDocument('failed-migration', () => legacy)
  try {
    expect(readCanvasDocument(recovered.doc).nodes.map((node) => node.id)).toEqual(['img'])
  } finally {
    await recovered.destroy()
  }
})

it('rejects an aborted migration read and leaves the database usable', async () => {
  const getAll = IDBObjectStore.prototype.getAll
  const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAll.apply(this, args)
    // The migration reads the complete log; y-indexeddb's own reads use a lower-bound range.
    if (this.name === 'updates' && args.length === 0) this.transaction.abort()
    return request
  })
  try {
    await expect(openNodeCanvasDocument('aborted-migration', () => legacy)).rejects.toBeDefined()
  } finally {
    spy.mockRestore()
  }
  const recovered = await openNodeCanvasDocument('aborted-migration', () => legacy)
  try {
    expect(readCanvasDocument(recovered.doc).nodes.map((node) => node.id)).toEqual(['img'])
  } finally {
    await recovered.destroy()
  }
})
