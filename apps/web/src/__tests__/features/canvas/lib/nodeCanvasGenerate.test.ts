import {
  canvasOrigin,
  connectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  readCanvasDocument,
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
    expect(mocks.start.mock.calls[0]![0].params.n).toBe(useStore.getState().params.n)
  })

  it('opens a sibling card for each extra fan-out index and keeps the same incoming edge', () => {
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
    expect(images).toHaveLength(3)
    const sibling = images.find((node) => node.id !== 'card' && node.id !== 'upstream')
    expect(sibling).toMatchObject({ y: 0, data: { pending: { status: 'loading' } } })
    expect(sibling!.x).toBeGreaterThan(0)
    expect(
      readCanvasDocument(ydoc).edges.some(
        (edge) => edge.source === 'upstream' && edge.target === sibling!.id,
      ),
    ).toBe(true)
  })

  it('preserves an existing image and places regeneration in a connected sibling', () => {
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
    expect(snapshot.nodes.find((n) => n.id === 'original')?.data).toEqual({
      fileId: 'source',
      meta: { nodePrompt: 'edit' },
    })
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({ source: 'original', target: snapshot.nodes[1]!.id }),
    )
    expect(snapshot.nodes[1]!.data).toMatchObject({ pending: { status: 'loading' } })
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
  updateCanvasNode(
    doc,
    'late',
    { data: { pending: { ...pending, meta: { ...meta, bffRequestId: 'confirmed' } } } },
    origin,
  )
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
  ).toEqual(['card', 'result:shared-task:1'])
  expect(readCanvasDocument(second).nodes).toEqual(readCanvasDocument(first).nodes)
  expect(mocks.completed).toHaveBeenCalledTimes(2)
  for (const [record] of mocks.completed.mock.calls) expect(record.id).toBe('canvas:shared-task')
  first.destroy()
  second.destroy()
})
