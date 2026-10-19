import type * as Y from 'yjs'
import {
  type CanvasNode,
  type CanvasOrigin,
  connectCanvasNodes,
  disconnectCanvasNodes,
  type ImageNodeData,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
} from './canvas-document'
import { findFreeCanvasPlacement, nodeCardSize } from './canvas-placement'
import { canvasNodeKind, canvasNodeRegistry } from './canvas-registry'
import { canvasInputFingerprint, canvasMainResult, canvasResultIsStale } from './canvas-results'
import { storyboardFingerprint } from './canvas-storyboard'
import { PRODUCTION_SHOTS_MAX, type ProductionShot } from './production-storyboard'
import { PROJECT_META_VALUE_MAX_CHARS, PROJECT_TIMELINE_MAX_CLIPS } from './project-protocol'
import {
  canonicalVideoVoice,
  clampVideoPreset,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoModelSupport,
  type VideoResolution,
} from './video-presets'

export const STORYBOARD_GRID_MAX = 9
export const STORYBOARD_TIMELINE_MAX_SECONDS = 600

export type StoryboardFlowErrorCode =
  | 'finalizeFirst'
  | 'noFirstFrameModel'
  | 'framesMissing'
  | 'promptTooLong'
  | 'missingAssets'

export class StoryboardFlowError extends Error {
  constructor(
    readonly code: StoryboardFlowErrorCode,
    readonly assets: string[] = [],
  ) {
    super(code)
  }
}

export interface StoryboardFlowContext {
  origin: CanvasOrigin
  names?: {
    frame(index: number): string
    grid(index: number): string
    video(index: number): string
  }
}

export interface StoryboardVideoDraft {
  model: string
  duration: VideoDuration
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  voices?: string[]
}

export interface StoryboardVideoModel {
  modelId: string
  support: VideoModelSupport
}

type StoryboardDocument = StoryboardFlowContext & { doc: Y.Doc }

/** Use the same card geometry and collision avoidance as manual canvas placement. */
function createNode(
  canvas: StoryboardDocument,
  kind: 'image' | 'video' | 'timeline',
  anchors: readonly CanvasNode[],
) {
  const id = crypto.randomUUID()
  const { width, height } = canvasNodeRegistry[kind].size
  const snapshot = readCanvasDocument(canvas.doc)
  const occupied = [
    ...snapshot.nodes.map((node) => ({ ...node, ...nodeCardSize(node) })),
    ...(snapshot.groups ?? []),
  ]
  const boxes = anchors.map((node) => ({ ...node, ...nodeCardSize(node) }))
  const gap = 168
  const x = Math.max(...boxes.map((node) => node.x + node.width)) + gap
  const preferredY = Math.min(...boxes.map((node) => node.y))
  const offset = findFreeCanvasPlacement([{ x, y: preferredY, width, height }], occupied, gap)
  insertCanvasNode(
    canvas.doc,
    {
      id,
      type: kind === 'timeline' ? 'timeline' : 'image',
      x,
      y: preferredY + offset.y,
      width,
      height,
      data: kind === 'timeline' ? { clips: [] } : { meta: { nodeKind: kind } },
    },
    canvas.origin,
  )
  return id
}

export type StoryboardFrameMode = 'grid' | 'individual'
export function storyboardGrid(count: number) {
  const columns = Math.ceil(Math.sqrt(Math.max(1, count)))
  return { columns, rows: Math.ceil(Math.max(1, count) / columns) }
}
function boardOf(canvas: StoryboardDocument, id: string) {
  const board = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === id)
  if (
    board?.type !== 'storyboard' ||
    !board.data.shots.length ||
    board.data.shots.length > PRODUCTION_SHOTS_MAX ||
    board.data.confirmed?.fingerprint !== storyboardFingerprint(board.data.shots)
  )
    throw new StoryboardFlowError('finalizeFirst')
  return board
}
function findGenerated(
  nodes: readonly CanvasNode[],
  boardId: string,
  role: string,
  shotId?: string,
) {
  return nodes.find(
    (node) =>
      (node.type === 'image' || node.type === 'video') &&
      node.data.meta?.storyboardId === boardId &&
      node.data.meta.storyboardRole === role &&
      (shotId === undefined || node.data.meta.storyboardShotId === shotId),
  )
}
export function storyboardMissingAssets(doc: Y.Doc, id: string): string[] {
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === id)
  if (board?.type !== 'storyboard') return []
  const nodes = readCanvasDocument(doc).nodes
  return [
    ...new Set(
      board.data.shots.flatMap((shot) => [
        ...shot.lookIds,
        ...(shot.locationId ? [shot.locationId] : []),
      ]),
    ),
  ].flatMap((id) => {
    const node = nodes.find((node) => node.id === id)
    return node?.type === 'image' && (node.data.fileId || node.data.mediaId)
      ? []
      : [node?.type === 'image' ? node.data.name || id : id]
  })
}
/** Preparation may create placeholders; execution must stop until these assets have pixels. */
export function assertStoryboardAssetsReady(doc: Y.Doc, id: string): void {
  const missing = storyboardMissingAssets(doc, id)
  if (missing.length) throw new StoryboardFlowError('missingAssets', missing)
}
const assetIds = (shot: ProductionShot) => [
  ...shot.lookIds,
  ...(shot.locationId ? [shot.locationId] : []),
]
function shotPrompt(shot: ProductionShot, video = false) {
  const prompt = [
    shot.description,
    shot.camera ? `Camera: ${shot.camera}` : '',
    video && shot.dialogue ? `Dialogue: ${shot.dialogue}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (prompt.length > PROJECT_META_VALUE_MAX_CHARS) throw new StoryboardFlowError('promptTooLong')
  return prompt
}
function gridPrompt(shots: readonly ProductionShot[]) {
  const { rows, columns } = storyboardGrid(shots.length)
  return [
    `Create one storyboard contact sheet, exactly ${rows} rows and ${columns} columns, ${shots.length} shots in reading order. Equal-size panels, no margins, gutters, borders, captions, or text. Keep character identities and visual style consistent. Leave unused final panels blank.`,
    ...shots.map((shot, i) => `Panel ${i + 1}: ${shotPrompt(shot)}`),
  ].join('\n')
}
/** Keep each contact sheet legible and inside the persisted prompt budget. */
export function storyboardGridBatches(shots: readonly ProductionShot[]) {
  const batches: ProductionShot[][] = []
  for (const shot of shots) {
    if (gridPrompt([shot]).length > PROJECT_META_VALUE_MAX_CHARS)
      throw new StoryboardFlowError('promptTooLong')
    const last = batches[batches.length - 1]
    if (
      last &&
      last.length < STORYBOARD_GRID_MAX &&
      gridPrompt([...last, shot]).length <= PROJECT_META_VALUE_MAX_CHARS
    )
      last.push(shot)
    else batches.push([shot])
  }
  return batches
}
/** Merge persisted fields only; readCanvasDocument includes transient job projections. */
export function patchStoryboardMedia(
  doc: Y.Doc,
  id: string,
  patch: Partial<ImageNodeData>,
  origin: CanvasOrigin,
) {
  const raw = doc.getMap<Y.Map<unknown>>('nodes').get(id)?.get('data') as ImageNodeData | undefined
  if (!raw) return
  updateCanvasNode(
    doc,
    id,
    { data: { ...raw, ...patch, meta: { ...raw.meta, ...patch.meta } } },
    origin,
  )
}
/** Only replace references previously managed by this workflow; keep manually added context. */
function linkSources(canvas: StoryboardDocument, target: string, sources: string[]) {
  const snapshot = readCanvasDocument(canvas.doc),
    node = snapshot.nodes.find((n) => n.id === target)
  if (!node || (node.type !== 'image' && node.type !== 'video')) return
  let old: unknown
  try {
    old = JSON.parse(node.data.meta?.storyboardSources ?? '[]')
  } catch {
    old = []
  }
  if (Array.isArray(old))
    for (const edge of snapshot.edges) {
      if (edge.target === target && old.includes(edge.source) && !sources.includes(edge.source))
        disconnectCanvasNodes(canvas.doc, edge.id, canvas.origin)
    }
  for (const source of sources) connectCanvasNodes(canvas.doc, { source, target }, canvas.origin)
  const current = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === target)!
  if (current.type === 'image' || current.type === 'video')
    patchStoryboardMedia(
      canvas.doc,
      target,
      { meta: { storyboardSources: JSON.stringify(sources) } },
      canvas.origin,
    )
}
/** Document preparation is one undo step; generation only starts in the batch confirmation. */
export function prepareStoryboardFrames(
  doc: Y.Doc,
  id: string,
  mode: StoryboardFrameMode,
  context: StoryboardFlowContext,
) {
  const canvas = { ...context, doc }
  const board = boardOf(canvas, id),
    fingerprint = storyboardFingerprint(board.data.shots)
  const frameIds: string[] = [],
    generateIds: string[] = []
  const batches = mode === 'grid' ? storyboardGridBatches(board.data.shots) : []
  board.data.shots.forEach((shot) => shotPrompt(shot))
  canvas.doc.transact(() => {
    for (const [index, shot] of board.data.shots.entries()) {
      const snapshot = readCanvasDocument(canvas.doc)
      const existing = findGenerated(snapshot.nodes, id, 'frame', shot.id)
      const frameId =
        existing?.id ?? createNode(canvas, 'image', [{ ...board, y: board.y + index * 408 }])
      const node = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === frameId)!
      if (node.type !== 'image') continue
      patchStoryboardMedia(
        canvas.doc,
        frameId,
        {
          name: canvas.names?.frame(index + 1) ?? `Shot ${index + 1} · First frame`,
          meta: {
            nodeKind: 'image',
            storyboardId: id,
            storyboardRole: 'frame',
            storyboardShotId: shot.id,
            storyboardFingerprint: fingerprint,
            nodePrompt: shotPrompt(shot),
          },
        },
        canvas.origin,
      )
      linkSources(canvas, frameId, assetIds(shot))
      frameIds.push(frameId)
    }
    if (mode === 'individual') generateIds.push(...frameIds)
    else
      for (const shots of batches) {
        const ids = shots.map(
          (shot) => frameIds[board.data.shots.findIndex((one) => one.id === shot.id)]!,
        )
        const { columns, rows } = storyboardGrid(shots.length)
        const existing = readCanvasDocument(canvas.doc).nodes.find(
          (node) =>
            node.type === 'image' &&
            node.data.meta?.storyboardId === id &&
            node.data.meta.storyboardRole === 'grid' &&
            node.data.meta.storyboardFrameIds === JSON.stringify(ids),
        )
        const gridId = existing?.id ?? createNode(canvas, 'image', [board])
        const grid = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === gridId)!
        if (grid.type !== 'image') continue
        patchStoryboardMedia(
          canvas.doc,
          gridId,
          {
            name:
              canvas.names?.grid(batches.indexOf(shots) + 1) ??
              `Contact sheet ${batches.indexOf(shots) + 1}`,
            meta: {
              nodeKind: 'image',
              storyboardId: id,
              storyboardRole: 'grid',
              storyboardFingerprint: fingerprint,
              storyboardFrameIds: JSON.stringify(ids),
              storyboardFrameBaseline: JSON.stringify(
                ids.map((id) => canvasMainResult(canvas.doc, id)?.id ?? null),
              ),
              storyboardFrameInputs: JSON.stringify(
                ids.map((id) => canvasInputFingerprint(canvas.doc, id)),
              ),
              storyboardGrid: JSON.stringify({ columns, rows }),
              nodePrompt: gridPrompt(shots),
            },
          },
          canvas.origin,
        )
        linkSources(canvas, gridId, [...new Set(shots.flatMap(assetIds))])
        generateIds.push(gridId)
      }
  }, canvas.origin)
  return { frameIds, generateIds }
}

/** Video slots exist before generation, so a failed or missing shot keeps its timeline position. */
export function prepareStoryboardVideos(
  doc: Y.Doc,
  id: string,
  draft: StoryboardVideoDraft,
  option: StoryboardVideoModel | undefined,
  context: StoryboardFlowContext,
) {
  const canvas = { ...context, doc }
  const board = boardOf(canvas, id),
    snapshot = readCanvasDocument(canvas.doc)
  if (!option?.support.firstFrame) throw new StoryboardFlowError('noFirstFrameModel')
  const frames = board.data.shots.map((shot) => findGenerated(snapshot.nodes, id, 'frame', shot.id))
  if (
    frames.some(
      (frame) =>
        frame?.type !== 'image' ||
        !(frame.data.fileId || frame.data.mediaId) ||
        !canvasMainResult(canvas.doc, frame.id)?.inputFingerprint ||
        canvasResultIsStale(canvas.doc, frame.id) ||
        frame.data.meta?.storyboardFingerprint !== storyboardFingerprint(board.data.shots),
    )
  )
    throw new StoryboardFlowError('framesMissing')
  board.data.shots.forEach((shot) => shotPrompt(shot, true))
  const videoIds: string[] = [],
    timelineIds: string[] = []
  const durations = new Map<string, number>()
  canvas.doc.transact(() => {
    for (const [index, shot] of board.data.shots.entries()) {
      const frame = frames[index]!,
        existing = findGenerated(readCanvasDocument(canvas.doc).nodes, id, 'video', shot.id)
      const videoId = existing?.id ?? createNode(canvas, 'video', [frame])
      const node = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === videoId)!
      if (node.type !== 'image' && node.type !== 'video') continue
      const voices = option.support.voices
        ? (draft.voices ?? [])
            .map((voice) => canonicalVideoVoice(voice))
            .filter((voice): voice is NonNullable<typeof voice> => voice !== null)
            .filter((voice, index, all) => all.indexOf(voice) === index)
            .slice(0, option.support.voices.max)
        : []
      const videoDraft: StoryboardVideoDraft = {
        ...draft,
        model: option.modelId,
        ...clampVideoPreset(option.support, {
          ...draft,
          duration: shot.durationSeconds ?? draft.duration,
        }),
        ...(voices.length ? { voices } : { voices: undefined }),
      }
      patchStoryboardMedia(
        canvas.doc,
        videoId,
        {
          name: canvas.names?.video(index + 1) ?? `Shot ${index + 1} · Video`,
          meta: {
            nodeKind: 'video',
            storyboardId: id,
            storyboardRole: 'video',
            storyboardShotId: shot.id,
            storyboardFingerprint: storyboardFingerprint(board.data.shots),
            nodeVideoMode: 'first',
            videoFirstFrame: frame.id,
            nodeVideoDraft: JSON.stringify(videoDraft),
            nodePrompt: shotPrompt(shot, true),
          },
        },
        canvas.origin,
      )
      linkSources(canvas, videoId, [frame.id, ...assetIds(shot)])
      videoIds.push(videoId)
      durations.set(videoId, videoDraft.duration)
    }
    const videos = readCanvasDocument(canvas.doc).nodes.filter(
      (node) => videoIds.includes(node.id) && canvasNodeKind(node) === 'video',
    )
    // Storage and export have the same clip bound. Never silently drop later shots.
    const chunks: string[][] = []
    let seconds = 0
    for (const id of videoIds) {
      const last = chunks[chunks.length - 1],
        duration = durations.get(id)!
      if (
        last &&
        last.length < PROJECT_TIMELINE_MAX_CLIPS &&
        seconds + duration <= STORYBOARD_TIMELINE_MAX_SECONDS
      ) {
        last.push(id)
        seconds += duration
      } else {
        chunks.push([id])
        seconds = duration
      }
    }
    for (const chunk of chunks) {
      const existing = readCanvasDocument(canvas.doc).nodes.find(
        (node) =>
          node.type === 'timeline' &&
          JSON.stringify(node.data.clips.map((clip) => clip.elementId)) === JSON.stringify(chunk),
      )
      const timelineId =
        existing?.id ??
        createNode(
          canvas,
          'timeline',
          videos.filter((node) => chunk.includes(node.id)),
        )
      for (const source of chunk)
        connectCanvasNodes(canvas.doc, { source, target: timelineId }, canvas.origin)
      if (!existing)
        updateCanvasNode(
          canvas.doc,
          timelineId,
          {
            data: {
              clips: chunk.map((elementId) => ({
                elementId,
                in: 0,
                out: durations.get(elementId)!,
              })),
            },
          },
          canvas.origin,
        )
      timelineIds.push(timelineId)
    }
  }, canvas.origin)
  return { videoIds, timelineIds }
}
