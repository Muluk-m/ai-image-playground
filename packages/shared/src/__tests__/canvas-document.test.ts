import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  beginCanvasTimelineEdit,
  CANVAS_NODE_TYPES,
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  disconnectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  type LegacyCanvasElement,
  moveCanvasNodes,
  readCanvasDocument,
  reconcileLegacyElements,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '../canvas-document'

/** 转换的反面：按叠放次序还原成旧存档的元素，核对转换没有丢东西。 */
function exportLegacyElements(doc: Y.Doc): LegacyCanvasElement[] {
  const { nodes, annotations } = readCanvasDocument(doc)
  return [...nodes, ...annotations]
    .sort((a, b) => a.z - b.z)
    .map((item) => {
      if (!('data' in item)) {
        const { z: _z, ...annotation } = item
        return annotation as LegacyCanvasElement
      }
      const { id, x, y, width, height } = item
      if ('pending' in item.data && item.data.pending)
        return { id, x, y, width, height, ...item.data.pending } as LegacyCanvasElement
      const type = item.type === 'video' ? 'image' : item.type
      return { id, type, x, y, width, height, ...item.data } as LegacyCanvasElement
    })
}

const generation = {
  model: 'grok-imagine-video',
  duration: 6,
  resolution: '720p',
  aspectRatio: '16:9',
} as const

const legacy: LegacyCanvasElement[] = [
  {
    id: 'img',
    type: 'image',
    fileId: 'file_1',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    rotation: 15,
    name: '海边',
    naturalWidth: 1536,
    naturalHeight: 1024,
    createdAt: 1700000000000,
    groupId: 'task_1',
    meta: { prompt: '海浪' },
  },
  {
    id: 'clip',
    type: 'image',
    mediaId: 'media_1',
    x: 400,
    y: 20,
    width: 320,
    height: 180,
    rotation: 0,
    video: { taskId: 'task_v', outputIndex: 0, generation },
  },
  { id: 'arrow', type: 'arrow', points: [0, 0, 50, 50], stroke: '#ef4444', strokeWidth: 12 },
  {
    id: 'note',
    type: 'text',
    x: 0,
    y: 300,
    text: '第一幕',
    fontSize: 64,
    fill: '#ef4444',
    width: 200,
    height: 80,
  },
  { id: 'pen', type: 'freedraw', points: [1, 2, 3, 4, 5, 6], stroke: '#000', strokeWidth: 4 },
  {
    id: 'pending',
    type: 'placeholder',
    x: 800,
    y: 0,
    width: 256,
    height: 256,
    status: 'loading',
    message: '',
    meta: { taskId: 'task_p', clientRequestId: 'req', source: 'builtin-edge', prompt: '猫' },
  },
  {
    id: 'reserved',
    type: 'generation',
    generationId: 'gen_1',
    position: 0,
    x: 1100,
    y: 0,
    width: 256,
    height: 256,
    errorCode: 'upstream_error',
  },
  {
    id: 'reel',
    type: 'timeline',
    x: 0,
    y: 500,
    width: 640,
    height: 120,
    clips: [{ elementId: 'clip', in: 0, out: 4 }],
  },
]

function imported(elements = legacy): Y.Doc {
  const doc = new Y.Doc()
  importLegacyElements(doc, elements, canvasOrigin('user', 'me'))
  return doc
}

describe('legacy conversion', () => {
  it('turns pictures, clips, text and timelines into nodes and marks into annotations', () => {
    const { nodes, annotations } = readCanvasDocument(imported())
    expect(nodes.map((node) => [node.id, node.type])).toEqual([
      ['img', 'image'],
      ['clip', 'video'],
      ['note', 'text'],
      ['pending', 'image'],
      ['reserved', 'image'],
      ['reel', 'timeline'],
    ])
    expect(annotations.map((one) => [one.id, one.type])).toEqual([
      ['arrow', 'arrow'],
      ['pen', 'freedraw'],
    ])
    expect(nodes.every((node) => CANVAS_NODE_TYPES.includes(node.type))).toBe(true)
  })

  it('keeps geometry and stacking order', () => {
    const { nodes, annotations } = readCanvasDocument(imported())
    const image = nodes.find((node) => node.id === 'img')!
    expect([image.x, image.y, image.width, image.height]).toEqual([10, 20, 300, 200])
    const order = [...nodes, ...annotations].sort((a, b) => a.z - b.z).map((one) => one.id)
    expect(order).toEqual(legacy.map((one) => one.id))
  })

  it('round-trips every element unchanged', () => {
    expect(exportLegacyElements(imported())).toEqual(legacy)
  })

  it('converts only once, even when the first conversion was empty', () => {
    const doc = new Y.Doc()
    importLegacyElements(doc, [], canvasOrigin('system', 'import'))
    importLegacyElements(doc, legacy, canvasOrigin('system', 'import'))
    expect(readCanvasDocument(doc).nodes).toEqual([])
  })

  it('does nothing to a document that already has content', () => {
    const doc = imported()
    importLegacyElements(doc, [legacy[3]!], canvasOrigin('user', 'me'))
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

it('converges when two replicas convert the same scene concurrently', () => {
  const left = imported()
  const right = imported()
  moveCanvasNodes(right, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
  expect(readCanvasDocument(left)).toEqual(readCanvasDocument(right))
  expect(readCanvasDocument(left).nodes).toHaveLength(6)
})

it('converges when independent replicas migrate different legacy snapshots', () => {
  const left = imported([{ ...legacy[0]!, id: 'old' }])
  const right = imported([{ ...legacy[0]!, id: 'new' }])
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
  const sorted = (doc: Y.Doc) =>
    readCanvasDocument(doc).nodes.sort((a, b) => a.id.localeCompare(b.id))
  expect(sorted(left)).toEqual(sorted(right))
  expect(sorted(left).map((node) => node.id)).toEqual(['new', 'old'])
})

describe('legacy write bridge', () => {
  const origin = canvasOrigin('system', 'legacy-bridge')

  it('adds and removes legacy elements without resetting independently moved nodes', () => {
    const before = [legacy[0]!]
    const doc = imported(before)
    moveCanvasNodes(doc, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    const added = [legacy[0]!, legacy[3]!]
    synchronizeLegacyElements(doc, before, added, origin)
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'img')).toMatchObject({
      x: 99,
      y: 88,
    })
    expect(readCanvasDocument(doc).nodes.map((node) => node.id)).toEqual(['img', 'note'])
    synchronizeLegacyElements(doc, added, [legacy[3]!], origin)
    expect(readCanvasDocument(doc).nodes.map((node) => node.id)).toEqual(['note'])
  })

  it('preserves the node map and user geometry when a pending task completes', () => {
    const pending = legacy[5]!
    const doc = imported([pending])
    const node = doc.getMap<Y.Map<unknown>>('nodes').get(pending.id)
    moveCanvasNodes(doc, [{ id: pending.id, x: 99, y: 88 }], canvasOrigin('user', 'me'))
    const finished = { ...legacy[0]!, id: pending.id }
    synchronizeLegacyElements(doc, [pending], [finished], origin)
    expect(doc.getMap('nodes').get(pending.id)).toBe(node)
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
      x: 99,
      y: 88,
      width: 256,
      height: 256,
      data: { fileId: 'file_1' },
    })
    expect(readCanvasDocument(doc).nodes[0]!.data).not.toHaveProperty('pending')
  })

  it('reuses an element reconciled before its queued legacy addition is replayed', () => {
    const doc = imported([])
    reconcileLegacyElements(doc, [legacy[0]!], origin)
    const node = doc.getMap('nodes').get('img')
    moveCanvasNodes(doc, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    synchronizeLegacyElements(doc, [], [legacy[0]!], origin)
    expect(doc.getMap('nodes').get('img')).toBe(node)
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({ x: 99, y: 88 })
  })

  it('preserves user geometry when an image becomes a video', () => {
    const doc = imported([legacy[0]!])
    moveCanvasNodes(doc, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    synchronizeLegacyElements(doc, [legacy[0]!], [{ ...legacy[1]!, id: 'img' }], origin)
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
      type: 'video',
      x: 99,
      y: 88,
      width: 300,
      height: 200,
    })
  })

  it('updates content and shared z order while keeping unchanged node coordinates', () => {
    const before = [legacy[0]!, legacy[2]!, legacy[3]!]
    const doc = imported(before)
    moveCanvasNodes(doc, [{ id: 'note', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    const next: LegacyCanvasElement[] = [
      {
        ...legacy[3]!,
        type: 'text',
        text: 'Updated',
        x: 0,
        y: 300,
        width: 200,
        height: 80,
        fontSize: 64,
        fill: '#ef4444',
      },
      legacy[0]!,
      legacy[2]!,
    ]
    synchronizeLegacyElements(doc, before, next, origin)
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'note')).toMatchObject({
      x: 99,
      y: 88,
      z: 0,
      data: { text: 'Updated' },
    })
    expect(readCanvasDocument(doc).annotations[0]).toMatchObject({ id: 'arrow', z: 2 })
  })

  it('reconciles missing and completed elements without deleting node-only content or moving nodes', () => {
    const pending = legacy[5]!
    const doc = imported([pending, { ...legacy[0]!, id: 'node-only' }])
    moveCanvasNodes(doc, [{ id: pending.id, x: 99, y: 88 }], canvasOrigin('user', 'me'))
    reconcileLegacyElements(doc, [{ ...legacy[0]!, id: pending.id }, legacy[3]!], origin)
    expect(
      readCanvasDocument(doc)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(['node-only', 'note', 'pending'])
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === pending.id)).toMatchObject({
      x: 99,
      y: 88,
      data: { fileId: 'file_1' },
    })
  })

  it.each(['error', 'stale'])('reconciles a recovered %s placeholder', (status) => {
    const pending = legacy[5]!
    const doc = imported([pending])
    reconcileLegacyElements(
      doc,
      [
        {
          ...pending,
          type: 'placeholder',
          status,
          message: 'Recovered',
          meta: {},
          x: 800,
          y: 0,
          width: 256,
          height: 256,
        },
      ],
      origin,
    )
    expect(readCanvasDocument(doc).nodes[0]!.data).toMatchObject({ pending: { status } })
  })
})

describe('moving nodes', () => {
  it('updates positions and survives a sync to another replica', () => {
    const doc = imported()
    moveCanvasNodes(doc, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    const moved = readCanvasDocument(replica).nodes.find((node) => node.id === 'img')!
    expect([moved.x, moved.y]).toEqual([99, 88])
  })

  it('ignores ids that are not nodes', () => {
    const doc = imported()
    moveCanvasNodes(doc, [{ id: 'arrow', x: 1, y: 1 }], canvasOrigin('user', 'me'))
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

describe('undo', () => {
  it('undoes only the changes made by its own origin', () => {
    const doc = imported()
    const me = canvasOrigin('user', 'me')
    const agent = canvasOrigin('agent', 'batch')
    const undo = createCanvasUndoManager(doc, me)
    moveCanvasNodes(doc, [{ id: 'img', x: 1, y: 1 }], me)
    undo.stopCapturing()
    moveCanvasNodes(doc, [{ id: 'note', x: 5, y: 5 }], agent)
    undo.undo()
    const { nodes } = readCanvasDocument(doc)
    expect(nodes.find((node) => node.id === 'img')).toMatchObject({ x: 10, y: 20 })
    expect(nodes.find((node) => node.id === 'note')).toMatchObject({ x: 5, y: 5 })
  })

  it('treats one call as one step and can redo it', () => {
    const doc = imported()
    const me = canvasOrigin('user', 'me')
    const undo = createCanvasUndoManager(doc, me)
    moveCanvasNodes(
      doc,
      [
        { id: 'img', x: 1, y: 1 },
        { id: 'note', x: 2, y: 2 },
      ],
      me,
    )
    undo.undo()
    expect(exportLegacyElements(doc)).toEqual(legacy)
    undo.redo()
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'note')).toMatchObject({
      x: 2,
      y: 2,
    })
  })

  it('does not undo the import itself', () => {
    const doc = new Y.Doc()
    const me = canvasOrigin('user', 'me')
    const undo = createCanvasUndoManager(doc, me)
    importLegacyElements(doc, legacy, canvasOrigin('system', 'import'))
    undo.undo()
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

describe('edges', () => {
  it('connects two nodes and rejects a self-link, a missing node, and a duplicate', () => {
    const doc = imported()
    const origin = canvasOrigin('user', 'me')
    expect(connectCanvasNodes(doc, { source: 'img', target: 'note' }, origin)).toBe(true)
    expect(connectCanvasNodes(doc, { source: 'img', target: 'note' }, origin)).toBe(false)
    expect(connectCanvasNodes(doc, { source: 'img', target: 'img' }, origin)).toBe(false)
    expect(connectCanvasNodes(doc, { source: 'img', target: 'missing' }, origin)).toBe(false)
    expect(readCanvasDocument(doc).edges).toEqual([
      { id: 'img:note', source: 'img', target: 'note' },
    ])
  })

  it('links many image nodes without rereading the whole document for each edge', () => {
    const doc = new Y.Doc()
    const origin = canvasOrigin('user', 'me')
    for (let index = 0; index < 200; index += 1)
      insertCanvasNode(
        doc,
        { id: `n${index}`, type: 'image', x: index, y: 0, width: 40, height: 40, data: {} },
        origin,
      )
    for (let index = 1; index < 200; index += 1)
      expect(
        connectCanvasNodes(doc, { source: `n${index - 1}`, target: `n${index}` }, origin),
      ).toBe(true)
    expect(readCanvasDocument(doc).edges).toHaveLength(199)
    expect(connectCanvasNodes(doc, { source: 'n0', target: 'n0' }, origin)).toBe(false)
  })

  it('undoes a connection without moving the nodes', () => {
    const doc = imported()
    const origin = canvasOrigin('user', 'me')
    const undo = createCanvasUndoManager(doc, origin)
    connectCanvasNodes(doc, { source: 'img', target: 'note' }, origin)
    undo.stopCapturing()
    undo.undo()
    expect(readCanvasDocument(doc).edges).toEqual([])
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'img')).toMatchObject({
      x: 10,
      y: 20,
    })
    undo.redo()
    expect(readCanvasDocument(doc).edges).toHaveLength(1)
  })

  it('drops an edge when either node leaves the legacy scene', () => {
    const doc = imported()
    connectCanvasNodes(doc, { source: 'img', target: 'note' }, canvasOrigin('user', 'me'))
    synchronizeLegacyElements(
      doc,
      legacy,
      legacy.filter((element) => element.id !== 'img'),
      canvasOrigin('system', 'legacy'),
    )
    const snapshot = readCanvasDocument(doc)
    expect(snapshot.nodes.some((node) => node.id === 'img')).toBe(false)
    expect(snapshot.edges).toEqual([])
  })

  it('keeps an inserted node across a legacy sync and removes it with its edges', () => {
    const doc = imported()
    const origin = canvasOrigin('system', 'node-insert')
    insertCanvasNode(
      doc,
      { id: 'empty', type: 'image', x: 4, y: 5, width: 280, height: 280, data: {} },
      origin,
    )
    updateCanvasNode(
      doc,
      'empty',
      { data: { pending: { type: 'placeholder', status: 'loading', message: '', meta: {} } } },
      origin,
    )
    synchronizeLegacyElements(doc, legacy, legacy, canvasOrigin('system', 'legacy'))
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'empty')!.data).toMatchObject({
      pending: { status: 'loading' },
    })
    connectCanvasNodes(doc, { source: 'img', target: 'empty' }, canvasOrigin('user', 'me'))
    deleteCanvasNode(doc, 'empty', canvasOrigin('user', 'me'))
    const snapshot = readCanvasDocument(doc)
    expect(snapshot.nodes.some((node) => node.id === 'empty')).toBe(false)
    expect(snapshot.edges).toEqual([])
    expect(disconnectCanvasNodes(doc, 'missing', canvasOrigin('user', 'me'))).toBeUndefined()
  })
})

it('tells actors apart by kind and id', () => {
  expect(canvasOrigin('user', 'me')).toBe(canvasOrigin('user', 'me'))
  expect(canvasOrigin('user', 'me')).not.toBe(canvasOrigin('agent', 'me'))
})

it('orders timeline connections, retains missing shots, and undoes clip edits with their edges', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'timeline')
  const undo = createCanvasUndoManager(doc, origin)
  for (const id of ['a', 'b'])
    insertCanvasNode(
      doc,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        data: { meta: { nodeKind: 'video' } },
      },
      origin,
    )
  insertCanvasNode(
    doc,
    {
      id: 'timeline',
      type: 'timeline',
      x: 500,
      y: 0,
      width: 560,
      height: 240,
      data: { clips: [] },
    },
    origin,
  )
  const clips = () =>
    (
      readCanvasDocument(doc).nodes.find((n) => n.id === 'timeline')!.data as {
        clips: { elementId: string; in: number; out?: number }[]
      }
    ).clips
  connectCanvasNodes(doc, { source: 'b', target: 'timeline' }, origin)
  connectCanvasNodes(doc, { source: 'a', target: 'timeline' }, origin)
  expect(clips().map((c) => c.elementId)).toEqual(['b', 'a'])
  expect(connectCanvasNodes(doc, { source: 'a', target: 'timeline' }, origin)).toBe(false)
  undo.stopCapturing()
  updateCanvasNode(
    doc,
    'timeline',
    { data: { clips: [{ elementId: 'a', in: 1, out: 4 }] } },
    origin,
  )
  expect(readCanvasDocument(doc).edges.map((e) => e.source)).toEqual(['a'])
  undo.undo()
  expect(clips().map((c) => c.elementId)).toEqual(['b', 'a'])
  expect(readCanvasDocument(doc).edges).toHaveLength(2)
  undo.stopCapturing()
  deleteCanvasNode(doc, 'b', origin)
  expect(clips().map((c) => c.elementId)).toEqual(['b', 'a'])
  disconnectCanvasNodes(doc, 'a:timeline', origin)
  expect(clips().map((c) => c.elementId)).toEqual(['b'])
})

it('refuses a 65th timeline connection without dropping a slot or adding an edge', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'timeline')
  insertCanvasNode(
    doc,
    {
      id: 'next',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  insertCanvasNode(
    doc,
    {
      id: 'full',
      type: 'timeline',
      x: 500,
      y: 0,
      width: 560,
      height: 240,
      data: { clips: Array.from({ length: 64 }, (_, i) => ({ elementId: `missing-${i}`, in: 0 })) },
    },
    origin,
  )
  expect(connectCanvasNodes(doc, { source: 'next', target: 'full' }, origin)).toBe(false)
  expect(readCanvasDocument(doc).edges).toHaveLength(0)
})

it('preserves concurrent shot additions in both replicas and retains a recovered slot when its source is deleted', () => {
  const a = new Y.Doc(),
    b = new Y.Doc(),
    origin = canvasOrigin('user', 'A'),
    remote = canvasOrigin('user', 'B')
  for (const id of ['a', 'b'])
    insertCanvasNode(
      a,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        data: { meta: { nodeKind: 'video' } },
      },
      origin,
    )
  insertCanvasNode(
    a,
    {
      id: 'timeline',
      type: 'timeline',
      x: 500,
      y: 0,
      width: 560,
      height: 240,
      data: { clips: [] },
    },
    origin,
  )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const undo = createCanvasUndoManager(a, origin)
  connectCanvasNodes(a, { source: 'a', target: 'timeline' }, origin)
  connectCanvasNodes(b, { source: 'b', target: 'timeline' }, remote)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const clips = (doc: Y.Doc) =>
    (
      readCanvasDocument(doc).nodes.find((n) => n.id === 'timeline')!.data as {
        clips: { elementId: string }[]
      }
    ).clips
  expect(clips(a)).toEqual(clips(b))
  expect(
    clips(a)
      .map((c) => c.elementId)
      .sort(),
  ).toEqual(['a', 'b'])
  undo.undo()
  expect(clips(a).map((c) => c.elementId)).toEqual(['b'])
  undo.redo()
  undo.stopCapturing()
  deleteCanvasNode(a, 'b', origin)
  expect(
    clips(a)
      .map((c) => c.elementId)
      .sort(),
  ).toEqual(['a', 'b'])
})

it('keeps independent trimmed additions after offline editing and source deletion', () => {
  const a = new Y.Doc(),
    b = new Y.Doc(),
    origin = canvasOrigin('user', 'a')
  for (const id of ['a', 'b'])
    insertCanvasNode(
      a,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        data: { meta: { nodeKind: 'video', videoTrimIn: '2', videoTrimOut: '4' } },
      },
      origin,
    )
  insertCanvasNode(
    a,
    { id: 'timeline', type: 'timeline', x: 0, y: 0, width: 500, height: 240, data: { clips: [] } },
    origin,
  )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  for (const [doc, id] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    connectCanvasNodes(doc, { source: id, target: 'timeline' }, origin)
    updateCanvasNode(
      doc,
      'timeline',
      { data: { clips: [{ elementId: id, in: 2.5, out: 3.5 }] } },
      origin,
    )
  }
  deleteCanvasNode(a, 'a', origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const timeline = readCanvasDocument(a).nodes.find((n) => n.id === 'timeline')!
  expect(timeline.data).toEqual({
    clips: [
      { elementId: 'a', in: 2.5, out: 3.5 },
      { elementId: 'b', in: 2.5, out: 3.5 },
    ],
  })
  expect(readCanvasDocument(b).nodes.find((n) => n.id === 'timeline')).toEqual(timeline)
})

it('preserves duplicate legacy slots while reordering and trimming', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    doc,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: {
        clips: [
          { elementId: 'a', in: 0, out: 1 },
          { elementId: 'a', in: 3, out: 4 },
        ],
      },
    },
    origin,
  )
  const clips = [
    { elementId: 'a', in: 3, out: 4 },
    { elementId: 'a', in: 0, out: 0.5 },
  ]
  updateCanvasNode(doc, 'timeline', { data: { clips } }, origin)
  expect(readCanvasDocument(doc).nodes[0].data).toEqual({ clips })
})

it('merges stale editor drafts without erasing remote additions, trims or deletions', () => {
  const a = new Y.Doc(),
    b = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    a,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: {
        clips: [
          { elementId: 'a', in: 0, out: 4 },
          { elementId: 'b', in: 0, out: 4 },
        ],
      },
    },
    origin,
  )
  insertCanvasNode(
    a,
    {
      id: 'c',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const draftA = beginCanvasTimelineEdit(a, 'timeline', origin),
    draftB = beginCanvasTimelineEdit(b, 'timeline', origin)
  draftA.save([draftA.clips[1], draftA.clips[0]])
  draftB.save([{ ...draftB.clips[0], in: 1, out: 3 }, draftB.clips[1]])
  connectCanvasNodes(b, { source: 'c', target: 'timeline' }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const clips = (doc: Y.Doc) =>
    (readCanvasDocument(doc).nodes.find((n) => n.id === 'timeline')!.data as { clips: unknown[] })
      .clips
  expect(clips(a)).toEqual([
    { elementId: 'b', in: 0, out: 4 },
    { elementId: 'a', in: 1, out: 3 },
    { elementId: 'c', in: 0 },
  ])
  expect(clips(a)).toEqual(clips(b))
  const stale = beginCanvasTimelineEdit(a, 'timeline', origin)
  connectCanvasNodes(b, { source: 'a', target: 'timeline' }, origin)
  updateCanvasNode(
    b,
    'timeline',
    {
      data: {
        clips: [
          { elementId: 'b', in: 0, out: 4 },
          { elementId: 'c', in: 0 },
        ],
      },
    },
    origin,
  )
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  stale.save(stale.clips.map((c) => (c.elementId === 'b' ? { ...c, in: 1 } : c)))
  expect(clips(a)).toEqual([
    { elementId: 'b', in: 1, out: 4 },
    { elementId: 'c', in: 0 },
  ])
})

it('keeps an unseen addition when a draft is saved after receiving it', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    doc,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: { clips: [{ elementId: 'a', in: 0, out: 4 }] },
    },
    origin,
  )
  insertCanvasNode(
    doc,
    {
      id: 'b',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  const draft = beginCanvasTimelineEdit(doc, 'timeline', origin)
  connectCanvasNodes(doc, { source: 'b', target: 'timeline' }, origin)
  draft.save([{ ...draft.clips[0], in: 1 }])
  expect(readCanvasDocument(doc).nodes[0].data).toEqual({
    clips: [
      { elementId: 'a', in: 1, out: 4 },
      { elementId: 'b', in: 0 },
    ],
  })
})

it('reorders slots with tied concurrent positions in the requested order', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    doc,
    { id: 'timeline', type: 'timeline', x: 0, y: 0, width: 500, height: 240, data: { clips: [] } },
    origin,
  )
  for (const id of ['a', 'b', 'c']) {
    doc
      .getMap('timelineSlots')
      .set(JSON.stringify(['timeline', 'source', id, 'clip']), { elementId: id, in: 0 })
    doc.getMap('timelineSlots').set(JSON.stringify(['timeline', 'source', id, 'order']), 0)
  }
  const draft = beginCanvasTimelineEdit(doc, 'timeline', origin)
  draft.save([draft.clips[1], draft.clips[0], draft.clips[2]])
  expect(readCanvasDocument(doc).nodes[0].data).toEqual({
    clips: [
      { elementId: 'b', in: 0 },
      { elementId: 'a', in: 0 },
      { elementId: 'c', in: 0 },
    ],
  })
})

it('keeps duplicate slot identity through concurrent ordering and trimming', () => {
  const a = new Y.Doc(),
    b = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    a,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: {
        clips: [
          { elementId: 'a', in: 0 },
          { elementId: 'a', in: 1 },
        ],
      },
    },
    origin,
  )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const first = beginCanvasTimelineEdit(a, 'timeline', origin),
    second = beginCanvasTimelineEdit(b, 'timeline', origin)
  first.save([{ ...first.clips[1], in: 2 }, first.clips[0]])
  second.save([{ ...second.clips[0], in: 0.5 }, second.clips[1]])
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(readCanvasDocument(a).nodes[0].data).toEqual({
    clips: [
      { elementId: 'a', in: 2 },
      { elementId: 'a', in: 0.5 },
    ],
  })
  expect(readCanvasDocument(b).nodes[0].data).toEqual(readCanvasDocument(a).nodes[0].data)
})

it('applies a legacy timeline edit without rewriting its immutable imported slot base', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  const timeline = {
    id: 'timeline',
    type: 'timeline' as const,
    x: 0,
    y: 0,
    width: 500,
    height: 240,
    clips: [
      { elementId: 'a', in: 0 },
      { elementId: 'b', in: 0 },
    ],
  }
  importLegacyElements(doc, [timeline], origin)
  updateCanvasNode(
    doc,
    'timeline',
    {
      data: {
        clips: [
          { elementId: 'b', in: 1 },
          { elementId: 'a', in: 0 },
        ],
      },
    },
    origin,
  )
  const previous = {
    ...timeline,
    clips: [
      { elementId: 'b', in: 1 },
      { elementId: 'a', in: 0 },
    ],
  }
  const next = { ...timeline, clips: [{ elementId: 'b', in: 2 }] }
  synchronizeLegacyElements(doc, [previous], [next], origin)
  expect(readCanvasDocument(doc).nodes[0].data).toEqual({ clips: next.clips })
  expect(doc.getMap<Y.Map<unknown>>('nodes').get('timeline')!.get('data')).toEqual({
    clips: timeline.clips,
  })
})
