// @vitest-environment jsdom
import {
  canvasOrigin,
  chooseCanvasResult,
  finishCanvasNodeJob,
  insertCanvasNode,
  readCanvasDocument,
  recordCanvasResult,
  setCanvasNodeJob,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { saveAssetNodeResult } from '../../../../features/canvas/lib/nodeAssetGeneration'
import { appendGeneratedAssetView } from '../../../../features/library/lib/assetStore'
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'

vi.mock('../../../../lib/cloudMedia', () => ({
  resolveMediaSource: async (s: string) => s,
  blobDataUrl: async () => 'data:image/png;base64,AA',
}))
vi.mock('../../../../lib/db', async (original) => ({
  ...(await original<typeof import('../../../../lib/db')>()),
  storeImage: async () => 'saved-image',
}))
vi.mock('../../../../features/library/lib/assetStore', () => ({
  assetStore: {},
  appendGeneratedAssetView: vi.fn(async () => ({ id: 'a' })),
}))
beforeEach(() => {
  setClientStorageScope(null)
  useLibraryStore.setState({ loadAssets: vi.fn(async () => {}) })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob() })),
  )
})
function fixture() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('system', 'test')
  const editor = new CanvasEditor(new CanvasDoc())
  const fileId = editor.doc.cacheBitmap('data:image/png;base64,AA')
  insertCanvasNode(
    doc,
    {
      id: 'node',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      data: { meta: { nodeKind: 'asset', assetId: 'a', assetKind: 'person' } },
    },
    origin,
  )
  recordCanvasResult(
    doc,
    { id: 'result', nodeId: 'node', kind: 'image', createdAt: 1, source: { type: 'file', fileId } },
    origin,
  )
  chooseCanvasResult(doc, 'node', 'result', { data: { fileId } }, origin)
  setCanvasNodeJob(
    doc,
    {
      id: 'job',
      nodeId: 'node',
      createdAt: 1,
      status: 'loading',
      message: '',
      meta: { nodeGeneration: true, clientRequestId: 'job', prompt: '' },
    },
    origin,
  )
  return { doc, editor, origin }
}
it('saves the candidate without persisting the derived loading projection', async () => {
  const { doc, editor, origin } = fixture()
  expect(await saveAssetNodeResult(editor, doc, 'node')).toBe(true)
  finishCanvasNodeJob(doc, 'job', origin)
  expect(readCanvasDocument(doc).nodes[0]!.data).not.toHaveProperty('pending')
  expect(vi.mocked(appendGeneratedAssetView).mock.calls[0]![1]).toMatchObject({ label: 'none' })
})
it('does not publish a result after switching accounts during the download', async () => {
  const { doc, editor } = fixture()
  vi.mocked(appendGeneratedAssetView).mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      setClientStorageScope('other')
      return { ok: true, blob: async () => new Blob() }
    }),
  )
  expect(await saveAssetNodeResult(editor, doc, 'node')).toBe(false)
  expect(appendGeneratedAssetView).not.toHaveBeenCalled()
})
