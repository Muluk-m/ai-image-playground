import {
  canvasInputFingerprint,
  canvasMainResult,
  canvasOrigin,
  canvasResultIsStale,
  chooseCanvasResult,
  connectCanvasNodes,
  createCanvasUndoManager,
  finishCanvasNodeJob,
  insertCanvasNode,
  readCanvasDocument,
  recordCanvasResult,
  setCanvasNodeJob,
  storyboardFingerprint,
  storyboardGridBatches,
  storyboardMissingAssets,
  updateCanvasNode,
  updateStoryboardShot,
  VIDEO_MODEL_SUPPORT,
} from '@image-playground/shared'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { copyNodes, pasteNodes } from '../../../../features/canvas/lib/nodeCanvasActions'
import {
  prepareStoryboardFrames,
  prepareStoryboardVideos,
} from '../../../../features/canvas/lib/nodeStoryboardFlow'
import { INITIAL_VIDEO_DRAFT } from '../../../../features/video/store'

function setup(count = 3) {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  const canvas = {
    doc,
    origin,
    undo,
    destroy: async () => {
      undo.destroy()
      doc.destroy()
    },
  }
  const shots = Array.from({ length: count }, (_, i) => ({
    id: `shot${i}`,
    description: `Scene ${i}`,
    lookIds: ['person'],
    durationSeconds: 5,
    camera: 'wide',
  }))
  insertCanvasNode(
    doc,
    {
      id: 'board',
      type: 'storyboard',
      x: 0,
      y: 0,
      width: 640,
      height: 340,
      data: {
        shots,
        confirmed: { fingerprint: storyboardFingerprint(shots), model: 'test', quantity: count },
      },
    },
    origin,
  )
  insertCanvasNode(
    doc,
    {
      id: 'person',
      type: 'image',
      x: -500,
      y: 0,
      width: 300,
      height: 240,
      data: {
        name: '芽芽',
        meta: { nodeKind: 'asset', assetKind: 'person', assetDescription: 'a sprout' },
      },
    },
    origin,
  )
  undo.clear()
  return canvas
}
function finalize(canvas: ReturnType<typeof setup>) {
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === 'board')!
  if (node.type === 'storyboard')
    updateCanvasNode(
      canvas.doc,
      node.id,
      {
        data: {
          ...node.data,
          confirmed: {
            fingerprint: storyboardFingerprint(node.data.shots),
            model: 'test',
            quantity: node.data.shots.length,
          },
        },
      },
      canvas.origin,
    )
}
function output(canvas: ReturnType<typeof setup>, id: string) {
  const result = {
    id: `result-${id}`,
    nodeId: id,
    kind: 'image' as const,
    createdAt: 1,
    source: { type: 'file' as const, fileId: `pixels-${id}` },
    inputFingerprint: canvasInputFingerprint(canvas.doc, id),
  }
  recordCanvasResult(canvas.doc, result, canvas.origin)
  chooseCanvasResult(
    canvas.doc,
    id,
    result.id,
    { data: { fileId: result.source.fileId } },
    canvas.origin,
  )
}
const options = [
  {
    modelId: 'grok-imagine-video',
    channelId: 'test',
    label: 'Grok',
    support: VIDEO_MODEL_SUPPORT['grok-imagine-video']!,
  },
]

it('prepares references and all frame placeholders in one undo step without submitting, and reuses them', () => {
  const canvas = setup(10)
  expect(storyboardMissingAssets(canvas.doc, 'board')).toEqual(['芽芽'])
  const result = prepareStoryboardFrames(canvas, 'board', 'grid')
  expect(result.frameIds).toHaveLength(10)
  expect(result.generateIds).toHaveLength(2)
  const snapshot = readCanvasDocument(canvas.doc)
  for (const id of [...result.frameIds, ...result.generateIds])
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ source: 'person', target: id }))
  expect(snapshot.nodes).toHaveLength(14)
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(2)
  canvas.undo.redo()
  expect(prepareStoryboardFrames(canvas, 'board', 'grid')).toEqual(result)
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(14)
})
it('splits long prompts into smaller sheets and refuses an oversized single shot before mutation', () => {
  const shots = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    description: 'x'.repeat(4000),
    lookIds: [],
  }))
  expect(storyboardGridBatches(shots).map((batch) => batch.length)).toEqual([2, 2])
  const canvas = setup()
  updateStoryboardShot(
    canvas.doc,
    'board',
    'shot0',
    { description: 'x'.repeat(10000), camera: 'extra' },
    canvas.origin,
  )
  finalize(canvas)
  const before = readCanvasDocument(canvas.doc)
  expect(() => prepareStoryboardFrames(canvas, 'board', 'individual')).toThrow()
  expect(readCanvasDocument(canvas.doc)).toEqual(before)
})
it('reconciles workflow asset references while preserving manually linked context and stales old frames', () => {
  const canvas = setup(1),
    result = prepareStoryboardFrames(canvas, 'board', 'individual'),
    id = result.frameIds[0]!
  insertCanvasNode(
    canvas.doc,
    {
      id: 'note',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: { text: 'Keep warm light', fill: '#fff', fontSize: 16 },
    },
    canvas.origin,
  )
  connectCanvasNodes(canvas.doc, { source: 'note', target: id }, canvas.origin)
  output(canvas, id)
  updateStoryboardShot(
    canvas.doc,
    'board',
    'shot0',
    { lookIds: [], description: 'changed' },
    canvas.origin,
  )
  finalize(canvas)
  prepareStoryboardFrames(canvas, 'board', 'individual')
  expect(
    readCanvasDocument(canvas.doc)
      .edges.filter((edge) => edge.target === id)
      .map((edge) => edge.source),
  ).toEqual(['note'])
  expect(canvasResultIsStale(canvas.doc, id)).toBe(true)
  expect(() => prepareStoryboardVideos(canvas, 'board', INITIAL_VIDEO_DRAFT, options)).toThrow()
})
it('requires all current first frames, makes first-frame videos in shot order, and keeps missing output slots', () => {
  const canvas = setup(3),
    frames = prepareStoryboardFrames(canvas, 'board', 'individual')
  expect(() => prepareStoryboardVideos(canvas, 'board', INITIAL_VIDEO_DRAFT, options)).toThrow()
  frames.frameIds.forEach((id) => output(canvas, id))
  const result = prepareStoryboardVideos(canvas, 'board', INITIAL_VIDEO_DRAFT, options)
  expect(result.videoIds).toHaveLength(3)
  const snapshot = readCanvasDocument(canvas.doc),
    timeline = snapshot.nodes.find((node) => node.id === result.timelineIds[0])!
  expect(timeline.type === 'timeline' && timeline.data.clips.map((clip) => clip.elementId)).toEqual(
    result.videoIds,
  )
  expect(timeline.type === 'timeline' && timeline.data.clips.every((clip) => clip.out === 5)).toBe(
    true,
  )
  for (const [index, id] of result.videoIds.entries()) {
    expect(canvasMainResult(canvas.doc, id)).toBeUndefined()
    expect(snapshot.nodes.find((node) => node.id === id)?.data).toMatchObject({
      meta: { nodeKind: 'video', nodeVideoMode: 'first', videoFirstFrame: frames.frameIds[index] },
    })
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ source: 'person', target: id }))
  }
  expect(prepareStoryboardVideos(canvas, 'board', INITIAL_VIDEO_DRAFT, options)).toEqual(result)
})
it('preserves every shot beyond the timeline clip limit', () => {
  const canvas = setup(65),
    frames = prepareStoryboardFrames(canvas, 'board', 'individual')
  frames.frameIds.forEach((id) => output(canvas, id))
  const result = prepareStoryboardVideos(canvas, 'board', INITIAL_VIDEO_DRAFT, options)
  const timelines = readCanvasDocument(canvas.doc).nodes.filter((node) => node.type === 'timeline')
  expect(timelines.map((node) => node.data.clips.length)).toEqual([64, 1])
  expect(timelines.flatMap((node) => node.data.clips.map((clip) => clip.elementId))).toEqual(
    result.videoIds,
  )
})
it('does not let copied outputs hijack the original storyboard workflow', () => {
  const canvas = setup(1),
    frames = prepareStoryboardFrames(canvas, 'board', 'grid')
  const copies = pasteNodes(
    canvas,
    copyNodes(readCanvasDocument(canvas.doc), [...frames.frameIds, ...frames.generateIds]),
    { x: 0, y: 1000 },
  )
  for (const node of readCanvasDocument(canvas.doc).nodes.filter((n) => copies.includes(n.id)))
    expect('meta' in node.data && node.data.meta?.storyboardId).toBeUndefined()
  expect(prepareStoryboardFrames(canvas, 'board', 'grid')).toEqual(frames)
})

it('does not persist transient pending projections when preparing an existing running node', () => {
  const canvas = setup(1),
    result = prepareStoryboardFrames(canvas, 'board', 'individual'),
    id = result.frameIds[0]!
  setCanvasNodeJob(
    canvas.doc,
    {
      id: 'job',
      nodeId: id,
      status: 'loading',
      createdAt: 1,
      message: 'Generating',
      meta: { nodeGeneration: true, prompt: 'test', clientRequestId: 'test' },
    },
    canvas.origin,
  )
  prepareStoryboardFrames(canvas, 'board', 'individual')
  finishCanvasNodeJob(canvas.doc, 'job', canvas.origin)
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)!
  expect('pending' in node.data && node.data.pending).toBeFalsy()
})
it('does not treat copied first-frame pixels without provenance as fresh after editing the copied board', () => {
  const canvas = setup(1),
    frames = prepareStoryboardFrames(canvas, 'board', 'individual')
  frames.frameIds.forEach((id) => output(canvas, id))
  const copies = pasteNodes(
    canvas,
    copyNodes(readCanvasDocument(canvas.doc), ['board', ...frames.frameIds]),
    { x: 0, y: 1000 },
  )
  const board = readCanvasDocument(canvas.doc).nodes.find(
    (n) => n.type === 'storyboard' && copies.includes(n.id),
  )!
  if (board.type !== 'storyboard') throw new Error('missing board')
  updateStoryboardShot(
    canvas.doc,
    board.id,
    'shot0',
    { description: 'a different scene' },
    canvas.origin,
  )
  const current = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === board.id)!
  if (current.type === 'storyboard')
    updateCanvasNode(
      canvas.doc,
      board.id,
      {
        data: {
          ...current.data,
          confirmed: {
            fingerprint: storyboardFingerprint(current.data.shots),
            model: 'test',
            quantity: 1,
          },
        },
      },
      canvas.origin,
    )
  prepareStoryboardFrames(canvas, board.id, 'individual')
  expect(() => prepareStoryboardVideos(canvas, board.id, INITIAL_VIDEO_DRAFT, options)).toThrow()
})

it('creates a continuation timeline before exceeding the film duration bound', () => {
  const canvas = setup(50)
  for (let i = 0; i < 50; i++)
    updateStoryboardShot(canvas.doc, 'board', `shot${i}`, { durationSeconds: 15 }, canvas.origin)
  finalize(canvas)
  const frames = prepareStoryboardFrames(canvas, 'board', 'individual')
  frames.frameIds.forEach((id) => output(canvas, id))
  prepareStoryboardVideos(canvas, 'board', { ...INITIAL_VIDEO_DRAFT, resolution: '720p' }, options)
  const timelines = readCanvasDocument(canvas.doc).nodes.filter((node) => node.type === 'timeline')
  expect(timelines.length).toBeGreaterThan(1)
  expect(timelines.flatMap((node) => node.data.clips)).toHaveLength(50)
  for (const timeline of timelines)
    expect(timeline.data.clips.reduce((sum, clip) => sum + (clip.out ?? 0), 0)).toBeLessThanOrEqual(
      600,
    )
})
