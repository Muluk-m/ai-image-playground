import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  assertStoryboardAssetsReady,
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasOrigin,
  chooseCanvasResult,
  createCanvasUndoManager,
  insertCanvasNode,
  prepareStoryboardFrames,
  prepareStoryboardVideos,
  readCanvasDocument,
  recordCanvasResult,
  StoryboardFlowError,
  type StoryboardVideoDraft,
  type StoryboardVideoModel,
  storyboardFingerprint,
  storyboardMissingAssets,
  updateCanvasNode,
  updateStoryboardShot,
  VIDEO_MODEL_SUPPORT,
} from '../index'

function setup(count = 3) {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'storyboard-test')
  const shots = Array.from({ length: count }, (_, index) => ({
    id: `shot-${index}`,
    description: `Scene ${index + 1}`,
    lookIds: ['person'],
    locationId: 'place',
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
        confirmed: { fingerprint: storyboardFingerprint(shots), model: 'image', quantity: count },
      },
    },
    origin,
  )
  for (const id of ['person', 'place']) {
    insertCanvasNode(
      doc,
      {
        id,
        type: 'image',
        x: -500,
        y: id === 'person' ? 0 : 500,
        width: 300,
        height: 240,
        data: {
          fileId: `pixels-${id}`,
          name: id === 'person' ? '芽芽' : '山谷',
          meta: { nodeKind: 'asset' },
        },
      },
      origin,
    )
  }
  return { doc, origin }
}

it('prepares contact sheets and per-shot frames directly in a document with asset references', () => {
  const { doc, origin } = setup(10)
  expect(storyboardMissingAssets(doc, 'board')).toEqual([])
  expect(() => assertStoryboardAssetsReady(doc, 'board')).not.toThrow()
  const result = prepareStoryboardFrames(doc, 'board', 'grid', { origin })
  expect(result.frameIds).toHaveLength(10)
  expect(result.generateIds).toHaveLength(2)
  const snapshot = readCanvasDocument(doc)
  expect(snapshot.nodes).toHaveLength(15)
  const first = snapshot.nodes.find((node) => node.id === result.frameIds[0])!
  expect(first).toMatchObject({
    x: 808,
    y: 0,
    data: {
      meta: {
        storyboardId: 'board',
        storyboardShotId: 'shot-0',
        storyboardRole: 'frame',
        nodePrompt: 'Scene 1\nCamera: wide',
      },
    },
  })
  for (const id of [...result.frameIds, ...result.generateIds]) {
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ source: 'person', target: id }))
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ source: 'place', target: id }))
  }
  const grids = snapshot.nodes.filter((node) => result.generateIds.includes(node.id))
  expect(grids.map((node) => 'meta' in node.data && node.data.meta?.storyboardGrid)).toEqual([
    '{"columns":3,"rows":3}',
    '{"columns":1,"rows":1}',
  ])
  expect(prepareStoryboardFrames(doc, 'board', 'grid', { origin })).toEqual(result)
  expect(prepareStoryboardFrames(doc, 'board', 'individual', { origin })).toEqual({
    frameIds: result.frameIds,
    generateIds: result.frameIds,
  })
})

const draft: StoryboardVideoDraft = {
  model: 'chosen',
  duration: 5,
  aspectRatio: '16:9',
  resolution: '720p',
}
const model: StoryboardVideoModel = {
  modelId: 'chosen',
  support: VIDEO_MODEL_SUPPORT['grok-imagine-video']!,
}

function finalize(doc: Y.Doc, origin: CanvasOrigin) {
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === 'board')!
  if (board.type !== 'storyboard') throw new Error('Missing storyboard')
  updateCanvasNode(
    doc,
    'board',
    {
      data: {
        ...board.data,
        confirmed: {
          fingerprint: storyboardFingerprint(board.data.shots),
          model: 'image',
          quantity: board.data.shots.length,
        },
      },
    },
    origin,
  )
}

function output(doc: Y.Doc, id: string, origin: CanvasOrigin, cloud = false) {
  const result = {
    id: `result-${id}`,
    nodeId: id,
    kind: 'image' as const,
    createdAt: 1,
    source: cloud
      ? { type: 'media' as const, mediaId: `pixels-${id}` }
      : { type: 'file' as const, fileId: `pixels-${id}` },
    inputFingerprint: canvasInputFingerprint(doc, id),
  }
  recordCanvasResult(doc, result, origin)
  chooseCanvasResult(
    doc,
    id,
    result.id,
    {
      data: cloud ? { mediaId: `pixels-${id}` } : { fileId: `pixels-${id}` },
    },
    origin,
  )
}

it('blocks asset execution with deduplicated missing names without preventing manual placeholders', () => {
  const { doc, origin } = setup()
  updateCanvasNode(doc, 'person', { data: { name: '芽芽', meta: { nodeKind: 'asset' } } }, origin)
  updateCanvasNode(doc, 'place', { data: { name: '山谷', meta: { nodeKind: 'asset' } } }, origin)
  expect(storyboardMissingAssets(doc, 'board')).toEqual(['芽芽', '山谷'])
  const before = readCanvasDocument(doc)
  expect(() => assertStoryboardAssetsReady(doc, 'board')).toThrow(
    new StoryboardFlowError('missingAssets', ['芽芽', '山谷']),
  )
  expect(readCanvasDocument(doc)).toEqual(before)
  expect(prepareStoryboardFrames(doc, 'board', 'individual', { origin }).frameIds).toHaveLength(3)
})

it('blocks unfinalized tables, missing frames and unavailable first-frame capabilities before mutation', () => {
  const { doc, origin } = setup()
  updateStoryboardShot(doc, 'board', 'shot-0', { description: 'Edited' }, origin)
  const before = readCanvasDocument(doc)
  expect(() => prepareStoryboardFrames(doc, 'board', 'grid', { origin })).toThrow('finalizeFirst')
  expect(() => prepareStoryboardVideos(doc, 'board', draft, model, { origin })).toThrow(
    'finalizeFirst',
  )
  expect(readCanvasDocument(doc)).toEqual(before)
  finalize(doc, origin)
  const finalized = readCanvasDocument(doc)
  expect(() => prepareStoryboardVideos(doc, 'board', draft, undefined, { origin })).toThrow(
    'noFirstFrameModel',
  )
  expect(() =>
    prepareStoryboardVideos(
      doc,
      'board',
      draft,
      {
        ...model,
        support: { ...model.support, firstFrame: false },
      },
      { origin },
    ),
  ).toThrow('noFirstFrameModel')
  expect(() => prepareStoryboardVideos(doc, 'board', draft, model, { origin })).toThrow(
    'framesMissing',
  )
  expect(readCanvasDocument(doc)).toEqual(finalized)
})

it('binds each first-frame slot and assets, constrains shot durations by capabilities and preserves missing video slots', () => {
  const { doc, origin } = setup()
  updateStoryboardShot(doc, 'board', 'shot-0', { durationSeconds: 3 }, origin)
  updateStoryboardShot(doc, 'board', 'shot-2', { durationSeconds: 8, dialogue: 'Hello' }, origin)
  finalize(doc, origin)
  const frames = prepareStoryboardFrames(doc, 'board', 'individual', { origin })
  frames.frameIds.forEach((id) => output(doc, id, origin))
  const capability: StoryboardVideoModel = {
    modelId: 'first-frame',
    support: {
      ...model.support,
      durations: [3, 5, 8],
      durationsByResolution: { '720p': [3, 5] },
    },
  }
  const result = prepareStoryboardVideos(doc, 'board', draft, capability, { origin })
  const snapshot = readCanvasDocument(doc)
  const videos = result.videoIds.map((id) => snapshot.nodes.find((node) => node.id === id)!)
  expect(
    videos.map((node) => 'meta' in node.data && JSON.parse(node.data.meta!.nodeVideoDraft!)),
  ).toEqual([
    { ...draft, model: 'first-frame', duration: 3 },
    { ...draft, model: 'first-frame', duration: 5 },
    { ...draft, model: 'first-frame', duration: 3 },
  ])
  for (const [index, id] of result.videoIds.entries()) {
    expect(videos[index]).toMatchObject({
      data: {
        meta: {
          nodeVideoMode: 'first',
          videoFirstFrame: frames.frameIds[index],
          storyboardShotId: `shot-${index}`,
        },
      },
    })
    for (const source of [frames.frameIds[index], 'person', 'place'])
      expect(snapshot.edges).toContainEqual(expect.objectContaining({ source, target: id }))
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({ source: id, target: result.timelineIds[0] }),
    )
    expect(canvasMainResult(doc, id)).toBeUndefined()
  }
  expect(videos[2]).toMatchObject({
    data: { meta: { nodePrompt: 'Scene 3\nCamera: wide\nDialogue: Hello' } },
  })
  expect(snapshot.nodes.find((node) => node.id === result.timelineIds[0])).toMatchObject({
    type: 'timeline',
    data: {
      clips: [
        { elementId: result.videoIds[0], in: 0, out: 3 },
        { elementId: result.videoIds[1], in: 0, out: 5 },
        { elementId: result.videoIds[2], in: 0, out: 3 },
      ],
    },
  })
  expect(prepareStoryboardVideos(doc, 'board', draft, capability, { origin })).toEqual(result)
})

it('prepares cloud-backed assets and frames without browser-local file IDs', () => {
  const { doc, origin } = setup(1)
  for (const id of ['person', 'place'])
    updateCanvasNode(
      doc,
      id,
      { data: { mediaId: `cloud-${id}`, meta: { nodeKind: 'asset' } } },
      origin,
    )
  expect(() => assertStoryboardAssetsReady(doc, 'board')).not.toThrow()
  const frames = prepareStoryboardFrames(doc, 'board', 'individual', { origin })
  output(doc, frames.frameIds[0]!, origin, true)
  expect(prepareStoryboardVideos(doc, 'board', draft, model, { origin }).videoIds).toHaveLength(1)
})

it('keeps shared preparation atomic for caller-owned undo history', () => {
  const { doc, origin } = setup(2)
  const undo = createCanvasUndoManager(doc, origin)
  const before = readCanvasDocument(doc)
  prepareStoryboardFrames(doc, 'board', 'grid', { origin })
  undo.undo()
  expect(readCanvasDocument(doc)).toEqual(before)
  undo.destroy()
})

for (const [count, duration, lengths] of [
  [65, 5, [64, 1]],
  [50, 15, [40, 10]],
] as const) {
  it(`preserves all ${count} shots in timeline chunks bounded by clip count and film length`, () => {
    const { doc, origin } = setup(count)
    if (duration !== 5) {
      for (let index = 0; index < count; index++)
        updateStoryboardShot(doc, 'board', `shot-${index}`, { durationSeconds: duration }, origin)
      finalize(doc, origin)
    }
    const frames = prepareStoryboardFrames(doc, 'board', 'individual', { origin })
    frames.frameIds.forEach((id) => output(doc, id, origin))
    const result = prepareStoryboardVideos(doc, 'board', draft, model, { origin })
    const timelines = readCanvasDocument(doc).nodes.filter((node) => node.type === 'timeline')
    expect(timelines.map((node) => node.data.clips.length)).toEqual([...lengths])
    expect(timelines.flatMap((node) => node.data.clips.map((clip) => clip.elementId))).toEqual(
      result.videoIds,
    )
    for (const timeline of timelines)
      expect(
        timeline.data.clips.reduce((sum, clip) => sum + (clip.out ?? 0), 0),
      ).toBeLessThanOrEqual(600)
  })
}
