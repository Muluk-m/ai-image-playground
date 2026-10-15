// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  canvasNodeJobs,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  setCanvasNodeJob,
} from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { openLocalNodeCanvas } from '../../../../features/canvas/lib/localNodeCanvas'
import { openNodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'

const image = (id: string): ImageEl => ({
  id,
  type: 'image',
  fileId: 'file',
  x: 10,
  y: 20,
  width: 100,
  height: 100,
  rotation: 0,
})
const sessions: Array<{
  controller: AbortController
  ready: ReturnType<typeof openLocalNodeCanvas>
}> = []
function fixture() {
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.elements = [image('image')]
  editor.doc.files = { file: 'data:image/png;base64,AA==' }
  return { editor, key: crypto.randomUUID() }
}
function open(key: string, editor: CanvasEditor) {
  const controller = new AbortController()
  const ready = openLocalNodeCanvas(key, editor, controller.signal)
  sessions.push({ controller, ready })
  return { controller, ready }
}
async function close(session: ReturnType<typeof open>) {
  const canvas = await session.ready
  session.controller.abort()
  if (canvas) await vi.waitFor(() => expect(canvas.doc.isDestroyed).toBe(true))
}
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.controller.abort()
    const canvas = await session.ready.catch(() => null)
    if (canvas) await vi.waitFor(() => expect(canvas.doc.isDestroyed).toBe(true))
  }
  vi.restoreAllMocks()
})

it('bridges later deliveries and projects edits without echoing them into undo history', async () => {
  const { editor, key } = fixture()
  const canvas = (await open(key, editor).ready)!
  moveCanvasNodes(canvas.doc, [{ id: 'image', x: 90, y: 80 }], canvas.origin)
  expect(editor.doc.elements.find((one) => one.id === 'image')).toMatchObject({ x: 90, y: 80 })
  editor.doc.addElements([image('delivered')])
  expect(readCanvasDocument(canvas.doc).nodes.map((one) => one.id)).toEqual(['image', 'delivered'])
  expect(canvas.undo.undoStack).toHaveLength(1)
  canvas.undo.undo()
  expect(editor.doc.elements.find((one) => one.id === 'image')).toMatchObject({ x: 10, y: 20 })
  expect(readCanvasDocument(canvas.doc).nodes.map((one) => one.id)).toContain('delivered')
})

it('includes a delivery while the real IndexedDB document is opening', async () => {
  const { editor, key } = fixture()
  const session = open(key, editor)
  editor.doc.addElements([image('during-open')])
  const canvas = (await session.ready)!
  expect(readCanvasDocument(canvas.doc).nodes.map((one) => one.id)).toEqual([
    'image',
    'during-open',
  ])
  await close(session)
  const reopened = (await open(key, editor).ready)!
  expect(readCanvasDocument(reopened.doc).nodes.map((one) => one.id)).toContain('during-open')
})

it('replays addition and deletion when migration reads the intermediate legacy scene', async () => {
  const { editor, key } = fixture()
  const getAll = IDBObjectStore.prototype.getAll
  let migrated = false
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAll.apply(this, args)
    if (this.name === 'updates' && args.length === 0) {
      request.addEventListener('success', () => {
        migrated = true
        editor.doc.addElements([image('transient')])
        // The migration's success handler reads this scene before the transaction commits.
        queueMicrotask(() => editor.doc.deleteElements(['transient']))
      })
    }
    return request
  })
  const session = open(key, editor)
  const canvas = (await session.ready)!
  expect(migrated).toBe(true)
  expect(readCanvasDocument(canvas.doc).nodes.map((one) => one.id)).toEqual(['image'])
  vi.restoreAllMocks()
  await close(session)
  expect(
    readCanvasDocument((await open(key, editor).ready)!.doc).nodes.map((one) => one.id),
  ).toEqual(['image'])
})

it('recovers unfinished image and video jobs only after opening and projecting the document', async () => {
  const { editor, key } = fixture()
  const seed = await openNodeCanvasDocument(key, () => editor.doc.elements)
  for (const type of ['image', 'video'] as const) {
    insertCanvasNode(
      seed.doc,
      { id: type, type, x: 0, y: 0, width: 100, height: 100, data: {} },
      seed.origin,
    )
    setCanvasNodeJob(
      seed.doc,
      {
        id: `job-${type}`,
        nodeId: type,
        createdAt: 1,
        status: 'loading',
        message: '',
        meta: {
          ...(type === 'image' ? { nodeGeneration: true } : { nodeVideo: true }),
          source: 'builtin-edge',
          prompt: 'recover',
          clientRequestId: `job-${type}`,
        },
      },
      seed.origin,
    )
  }
  await seed.destroy()
  const canvas = (await open(key, editor).ready)!
  expect(canvasNodeJobs(canvas.doc).map((job) => [job.id, job.status])).toEqual([
    ['job-image', 'stale'],
    ['job-video', 'stale'],
  ])
})

it('closes an opening document without projecting or resuming it after the caller leaves', async () => {
  const { editor, key } = fixture()
  const seed = await openNodeCanvasDocument(key, () => editor.doc.elements)
  setCanvasNodeJob(
    seed.doc,
    {
      id: 'unaccepted',
      nodeId: 'image',
      createdAt: 1,
      status: 'loading',
      message: '',
      meta: {
        nodeGeneration: true,
        source: 'builtin-edge',
        prompt: 'recover',
        clientRequestId: 'unaccepted',
      },
    },
    seed.origin,
  )
  await seed.destroy()
  const session = open(key, editor)
  session.controller.abort()
  expect(await session.ready).toBeNull()
  editor.doc.addElements([image('after-close')])
  const persisted = await openNodeCanvasDocument(key, () => [])
  expect(readCanvasDocument(persisted.doc).nodes.map((one) => one.id)).toEqual(['image'])
  expect(canvasNodeJobs(persisted.doc)[0]!.status).toBe('loading')
  await persisted.destroy()
})

it('detaches the bridge on close and reopens saved content with an empty undo history', async () => {
  const { editor, key } = fixture()
  const session = open(key, editor)
  const canvas = (await session.ready)!
  moveCanvasNodes(canvas.doc, [{ id: 'image', x: 90, y: 80 }], canvas.origin)
  await close(session)
  editor.doc.addElements([image('after-close')])
  expect(readCanvasDocument(canvas.doc).nodes.map((one) => one.id)).not.toContain('after-close')
  const reopened = (await open(key, editor).ready)!
  expect(readCanvasDocument(reopened.doc).nodes.find((one) => one.id === 'image')).toMatchObject({
    x: 90,
    y: 80,
  })
  expect(reopened.undo.undoStack).toHaveLength(0)
})

it('reports an opening failure and allows the next mount to retry', async () => {
  const { editor, key } = fixture()
  const getAll = IDBObjectStore.prototype.getAll
  const failure = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAll.apply(this, args)
    if (this.name === 'updates' && args.length === 0) this.transaction.abort()
    return request
  })
  const session = open(key, editor)
  await expect(session.ready).rejects.toBeDefined()
  session.controller.abort()
  failure.mockRestore()
  expect(
    readCanvasDocument((await open(key, editor).ready)!.doc).nodes.map((one) => one.id),
  ).toEqual(['image'])
})
