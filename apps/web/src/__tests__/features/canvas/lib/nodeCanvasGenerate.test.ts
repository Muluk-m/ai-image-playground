import {
  canvasNodeJobs,
  canvasOrigin,
  canvasResults,
  connectCanvasNodes,
  deleteCanvasNode,
  importLegacyElements,
  insertCanvasNode,
  readCanvasDocument,
  setCanvasNodeJob,
  updateCanvasNode,
} from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  resumeNodeGenerations,
  submitNodeImage,
} from '../../../../features/canvas/lib/nodeCanvasGenerate'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), completed: vi.fn() }))
vi.mock('../../../../store', async (original) => ({
  ...(await original<typeof import('../../../../store')>()),
  addCompletedCanvasTask: mocks.completed,
}))
vi.mock('../../../../lib/canvasImage', async (original) => ({
  ...(await original<typeof import('../../../../lib/canvasImage')>()),
  getImageDimensions: async () => ({ width: 100, height: 100 }),
}))

vi.mock('../../../../lib/generationJob', () => ({
  startGeneration: mocks.start,
  resumeGeneration: mocks.resume,
}))

describe('submitNodeImage', () => {
  beforeEach(() => {
    mocks.start.mockReset()
    mocks.start.mockImplementation((spec, sink) => {
      const variant = spec.variants[0]
      return [
        sink.open({
          prompt: variant.prompt,
          params: spec.params,
          inputImageDataUrls: variant.inputImageDataUrls,
          clientRequestId: 'req-1',
          index: 0,
          context: variant.context,
        }),
      ]
    })
  })

  it('marks the same image node as generating', () => {
    const ydoc = new Y.Doc()
    importLegacyElements(ydoc, [], canvasOrigin('system', 'fixture'))
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      canvasOrigin('system', 'node-insert'),
    )
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '屋顶看星星', [])).toBe(true)
    expect(readCanvasDocument(ydoc).nodes.find((node) => node.id === 'card')!.data).toMatchObject({
      pending: { type: 'placeholder', status: 'loading' },
    })
    expect(mocks.start.mock.calls[0]![0].outputRetention).toBe('candidate')
    expect(mocks.start.mock.calls[0]![0].params.n).toBe(useStore.getState().params.n)
  })

  it('keeps fan-out jobs in one node with independent recovery references', () => {
    mocks.start.mockImplementation((spec, sink) => {
      const variant = spec.variants[0]
      return [0, 1].map((index) =>
        sink.open({
          prompt: variant.prompt,
          params: spec.params,
          inputImageDataUrls: variant.inputImageDataUrls,
          clientRequestId: `req-${index}`,
          index,
          context: variant.context,
        }),
      )
    })
    const ydoc = new Y.Doc()
    importLegacyElements(ydoc, [], canvasOrigin('system', 'fixture'))
    const origin = canvasOrigin('system', 'node-insert')
    insertCanvasNode(
      ydoc,
      { id: 'upstream', type: 'image', x: -200, y: 0, width: 80, height: 80, data: {} },
      origin,
    )
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      origin,
    )
    connectCanvasNodes(ydoc, { source: 'upstream', target: 'card' }, origin)
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '两张', [])).toBe(true)
    const images = readCanvasDocument(ydoc).nodes.filter((node) => node.type === 'image')
    expect(images).toHaveLength(2)
    expect(canvasNodeJobs(ydoc, 'card')).toHaveLength(2)
    expect(canvasNodeJobs(ydoc, 'card').map((job) => job.meta.clientRequestId)).toEqual([
      'req-0',
      'req-1',
    ])
    expect(readCanvasDocument(ydoc).edges).toHaveLength(1)
  })

  it('preserves the existing image as a candidate and generates in the same node', () => {
    const doc = new Y.Doc()
    insertCanvasNode(
      doc,
      {
        id: 'original',
        type: 'image',
        x: 0,
        y: 0,
        width: 360,
        height: 240,
        data: { fileId: 'source', meta: { nodePrompt: 'edit' } },
      },
      canvasOrigin('system', 'fixture'),
    )
    expect(
      submitNodeImage(new CanvasEditor(new CanvasDoc()), doc, 'original', 'edit', [
        'data:image/png;base64,source',
      ]),
    ).toBe(true)
    const snapshot = readCanvasDocument(doc)
    expect(snapshot.nodes.find((n) => n.id === 'original')?.data).toMatchObject({
      fileId: 'source',
      meta: { nodePrompt: 'edit' },
      pending: { status: 'loading' },
    })
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.edges).toHaveLength(0)
    expect(canvasResults(doc, 'original')).toHaveLength(1)
  })

  it('does not start when there is nothing to say and nothing to reference', () => {
    const ydoc = new Y.Doc()
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      canvasOrigin('system', 'node-insert'),
    )
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '   ', [])).toBe(false)
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

it('resumes a cloud image job when its request id arrives after initial loading', () => {
  mocks.resume.mockClear()
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'resume')
  const meta = { nodeGeneration: true, prompt: 'test', source: 'builtin-edge' }
  const pending = { type: 'placeholder' as const, status: 'loading', message: '', meta }
  insertCanvasNode(
    doc,
    { id: 'late', type: 'image', x: 0, y: 0, width: 100, height: 100, data: { pending } },
    origin,
  )
  const editor = new CanvasEditor(new CanvasDoc())
  resumeNodeGenerations(editor, doc, false)
  expect(mocks.resume).not.toHaveBeenCalled()
  const job = canvasNodeJobs(doc, 'late')[0]!
  setCanvasNodeJob(doc, { ...job, meta: { ...job.meta, bffRequestId: 'confirmed' } }, origin)
  resumeNodeGenerations(editor, doc, false)
  resumeNodeGenerations(editor, doc, false)
  expect(mocks.resume).toHaveBeenCalledTimes(1)
  doc.destroy()
})

it('merges multi-image results from two recovering devices into the same output nodes', async () => {
  mocks.resume.mockReset()
  mocks.completed.mockClear()
  mocks.resume.mockImplementation(async (_spec, handle, sink) => {
    await sink.delivered(handle, {
      images: ['data:image/png;base64,one', 'data:image/png;base64,two'],
    })
  })
  const first = new Y.Doc(),
    second = new Y.Doc()
  insertCanvasNode(
    first,
    {
      id: 'card',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: {
        pending: {
          type: 'placeholder',
          status: 'loading',
          message: '',
          meta: {
            nodeGeneration: true,
            prompt: 'two',
            source: 'builtin-edge',
            bffRequestId: 'shared-task',
          },
        },
      },
    },
    canvasOrigin('system', 'fixture'),
  )
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
  resumeNodeGenerations(new CanvasEditor(new CanvasDoc()), first, false)
  resumeNodeGenerations(new CanvasEditor(new CanvasDoc()), second, false)
  await Promise.all(mocks.resume.mock.results.map((result) => result.value))
  Y.applyUpdate(first, Y.encodeStateAsUpdate(second))
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
  expect(
    readCanvasDocument(first)
      .nodes.map((node) => node.id)
      .sort(),
  ).toEqual(['card'])
  expect(canvasResults(first, 'card')).toHaveLength(2)
  expect(canvasResults(first, 'card')).toEqual(canvasResults(second, 'card'))
  expect(readCanvasDocument(second).nodes).toEqual(readCanvasDocument(first).nodes)
  expect(mocks.completed).toHaveBeenCalledTimes(2)
  for (const [record] of mocks.completed.mock.calls) expect(record.id).toBe('canvas:shared-task')
  first.destroy()
  second.destroy()
})

it.each([
  false,
  true,
])('does not overwrite or resurrect a settled output on late delivery (deleted=%s)', async (deleted) => {
  mocks.resume.mockReset()
  const doc = new Y.Doc(),
    editor = new CanvasEditor(new CanvasDoc())
  const origin = canvasOrigin('user', 'fixture')
  insertCanvasNode(
    doc,
    {
      id: 'card',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: {
        pending: {
          type: 'placeholder',
          status: 'loading',
          message: '',
          meta: {
            nodeGeneration: true,
            prompt: 'two',
            source: 'builtin-edge',
            bffRequestId: 'late-task',
          },
        },
      },
    },
    origin,
  )
  resumeNodeGenerations(editor, doc, false)
  const [, handle, sink] = mocks.resume.mock.calls[0]!
  updateCanvasNode(doc, 'card', { data: { fileId: 'settled-primary' } }, origin)
  const resultId = 'result:late-task:1'
  insertCanvasNode(
    doc,
    {
      id: resultId,
      type: 'image',
      x: 200,
      y: 60,
      width: 150,
      height: 200,
      data: { fileId: 'user-replacement' },
    },
    origin,
  )
  if (deleted) deleteCanvasNode(doc, resultId, origin)
  const place = vi.spyOn(editor, 'placeImages')
  await sink.delivered(handle, {
    images: ['data:image/png;base64,one', 'data:image/png;base64,two'],
  })
  expect(place).not.toHaveBeenCalled()
  const output = readCanvasDocument(doc).nodes.find((node) => node.id === resultId)
  if (deleted) {
    expect(output).toBeUndefined()
    expect(doc.getMap('deletedNodes').has(resultId)).toBe(true)
  } else
    expect(output).toMatchObject({
      x: 200,
      y: 60,
      width: 150,
      height: 200,
      data: { fileId: 'user-replacement' },
    })
  doc.destroy()
})
