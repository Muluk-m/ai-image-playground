// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { insertAssetNode } from '../../../../features/canvas/lib/nodeAssets'
import { createNode } from '../../../../features/canvas/lib/nodeCanvasActions'
import {
  composeNodePrompt,
  incomingReferences,
  referenceFileIds,
} from '../../../../features/canvas/lib/nodeCanvasFlow'
import { nodeVideoInputs } from '../../../../features/canvas/lib/nodeVideoModes'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord } from '../../../../features/library/types'
import { setClientStorageScope } from '../../../../lib/authScope'
import { loadImageOriginal } from '../../../../lib/imageSource'

vi.mock('../../../../lib/imageSource', () => ({
  loadImageOriginal: vi.fn(async () => 'data:image/png;base64,AA'),
}))
vi.mock('../../../../lib/sync/assetImages', () => ({ ensureAssetImage: vi.fn(async () => true) }))
vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: vi.fn(async () => ({ width: 640, height: 360 })),
}))
const asset: AssetRecord = {
  id: 'place',
  name: '雨夜街角',
  kind: 'location',
  description: '霓虹灯与湿润街道',
  views: [],
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}
function fixture() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = {
    doc,
    origin,
    undo,
    destroy: async () => {
      undo.destroy()
      doc.destroy()
    },
  }
  return { canvas, editor: new CanvasEditor(new CanvasDoc()) }
}
beforeEach(() => {
  setClientStorageScope(null)
  vi.mocked(loadImageOriginal).mockResolvedValue('data:image/png;base64,AA')
  useLibraryStore.setState({ assets: [asset], noteAssetUsed: vi.fn(async () => {}) })
})
it('inserts an image-free asset and its real upstream link as one undo, keeping description across video modes', async () => {
  const { canvas, editor } = fixture()
  const target = createNode(canvas, 'video', { x: 600, y: 200 }, '')
  const id = await insertAssetNode(
    editor,
    canvas,
    asset,
    { x: 0, y: 0 },
    target,
    '',
    '@雨夜街角 镜头推进',
  )
  const snapshot = readCanvasDocument(canvas.doc)
  const source = snapshot.nodes.find((node) => node.id === id)!
  expect(source.data).toMatchObject({
    name: asset.name,
    meta: { nodeKind: 'asset', assetId: asset.id, assetDescription: asset.description },
  })
  const refs = incomingReferences(snapshot.nodes, snapshot.edges, target)
  expect(referenceFileIds(refs, {})).toEqual([])
  for (const mode of ['text', 'first', 'frames', 'reference'] as const) {
    const inputs = nodeVideoInputs(mode, refs)
    expect(composeNodePrompt('镜头推进', inputs.refs)).toContain('雨夜街角：霓虹灯与湿润街道')
    expect(inputs.first).toBeUndefined()
    expect(inputs.roles).toEqual({})
  }
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).nodes.map((node) => node.id)).toEqual([target])
  expect(readCanvasDocument(canvas.doc).edges).toEqual([])
  expect(readCanvasDocument(canvas.doc).nodes[0]!.data).not.toHaveProperty('meta.nodePrompt')
  canvas.undo.redo()
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
})
it('resolves image dimensions before placement and does not overlap existing cards', async () => {
  const { canvas, editor } = fixture()
  const imageAsset = {
    ...asset,
    views: [{ imageId: 'original', label: 'none' as const, source: 'upload' as const }],
  }
  useLibraryStore.setState({ assets: [imageAsset] })
  await insertAssetNode(editor, canvas, imageAsset, { x: 0, y: 0 })
  await insertAssetNode(editor, canvas, imageAsset, { x: 0, y: 0 })
  const [a, b] = readCanvasDocument(canvas.doc).nodes
  expect(a).toMatchObject({ width: 360, height: 240 })
  expect(b!.y).toBeGreaterThan(a!.y + a!.height)
  expect(a?.data).toMatchObject({
    naturalWidth: 640,
    naturalHeight: 360,
    meta: { assetImageId: 'original' },
  })
})
it('never inserts a partial card when the image is unavailable or the account changes while loading', async () => {
  const { canvas, editor } = fixture()
  const imageAsset = {
    ...asset,
    views: [{ imageId: 'original', label: 'none' as const, source: 'upload' as const }],
  }
  useLibraryStore.setState({ assets: [imageAsset] })
  vi.mocked(loadImageOriginal).mockResolvedValueOnce(null)
  await expect(insertAssetNode(editor, canvas, imageAsset, { x: 0, y: 0 })).rejects.toThrow()
  vi.mocked(loadImageOriginal).mockImplementationOnce(async () => {
    setClientStorageScope('other')
    return 'data:image/png;base64,AA'
  })
  expect(await insertAssetNode(editor, canvas, imageAsset, { x: 0, y: 0 })).toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes).toEqual([])
})

it('does not overwrite a newer prompt when a referenced image finishes loading late', async () => {
  const { canvas, editor } = fixture()
  const target = createNode(canvas, 'image', { x: 600, y: 200 }, '')
  const imageAsset = {
    ...asset,
    views: [{ imageId: 'original', label: 'none' as const, source: 'upload' as const }],
  }
  useLibraryStore.setState({ assets: [imageAsset] })
  vi.mocked(loadImageOriginal).mockImplementationOnce(async () => {
    const node = readCanvasDocument(canvas.doc).nodes.find((one) => one.id === target)!
    updateCanvasNode(
      canvas.doc,
      target,
      { data: { ...node.data, meta: { nodePrompt: 'newer edit' } } },
      canvas.origin,
    )
    return 'data:image/png;base64,AA'
  })
  expect(
    await insertAssetNode(
      editor,
      canvas,
      imageAsset,
      { x: 0, y: 0 },
      target,
      'original',
      '@old text',
    ),
  ).toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(1)
  expect(readCanvasDocument(canvas.doc).nodes[0]!.data).toMatchObject({
    meta: { nodePrompt: 'newer edit' },
  })
})
