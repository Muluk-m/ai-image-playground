import {
  type CanvasNode,
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeKind,
  canvasResultIsStale,
  clampVideoPreset,
  connectCanvasNodes,
  disconnectCanvasNodes,
  type ImageNodeData,
  PRODUCTION_SHOTS_MAX,
  PROJECT_META_VALUE_MAX_CHARS,
  PROJECT_TIMELINE_MAX_CLIPS,
  type ProductionShot,
  readCanvasDocument,
  storyboardFingerprint,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { i18next } from '../../../i18n'
import type { VideoModelOption } from '../../../lib/channels/videoChannels'
import { clampDraftToSupport } from '../../video/lib/draft'
import type { VideoDraft } from '../../video/types'
import { FILM_MAX_SECONDS } from './filmSpec'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { nodeVideoSupport } from './nodeVideoModes'

const t = i18next.getFixedT(null, 'canvas')
export const STORYBOARD_GRID_MAX = 9

export class StoryboardFlowError extends Error {}
export type StoryboardFrameMode = 'grid' | 'individual'
export function storyboardGrid(count: number) {
  const columns = Math.ceil(Math.sqrt(Math.max(1, count)))
  return { columns, rows: Math.ceil(Math.max(1, count) / columns) }
}
function boardOf(canvas: NodeCanvasDocument, id: string) {
  const board = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === id)
  if (
    board?.type !== 'storyboard' ||
    !board.data.shots.length ||
    board.data.shots.length > PRODUCTION_SHOTS_MAX ||
    board.data.confirmed?.fingerprint !== storyboardFingerprint(board.data.shots)
  )
    throw new StoryboardFlowError(t('storyFlow.finalizeFirst', {}))
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
export function storyboardMissingAssets(canvas: NodeCanvasDocument, id: string): string[] {
  const board = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === id)
  if (board?.type !== 'storyboard') return []
  const nodes = readCanvasDocument(canvas.doc).nodes
  return [
    ...new Set(
      board.data.shots.flatMap((shot) => [
        ...shot.lookIds,
        ...(shot.locationId ? [shot.locationId] : []),
      ]),
    ),
  ].flatMap((id) => {
    const node = nodes.find((node) => node.id === id)
    return node?.type === 'image' && node.data.fileId
      ? []
      : [node?.type === 'image' ? node.data.name || id : id]
  })
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
  if (prompt.length > PROJECT_META_VALUE_MAX_CHARS)
    throw new StoryboardFlowError(t('storyFlow.promptTooLong'))
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
      throw new StoryboardFlowError(t('storyFlow.promptTooLong'))
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
  canvas: NodeCanvasDocument,
  id: string,
  patch: Partial<ImageNodeData>,
  origin: CanvasOrigin = canvas.origin,
) {
  const raw = canvas.doc.getMap<Y.Map<unknown>>('nodes').get(id)?.get('data') as
    | ImageNodeData
    | undefined
  if (!raw) return
  updateCanvasNode(
    canvas.doc,
    id,
    { data: { ...raw, ...patch, meta: { ...raw.meta, ...patch.meta } } },
    origin,
  )
}
/** Only replace references previously managed by this workflow; keep manually added context. */
function linkSources(canvas: NodeCanvasDocument, target: string, sources: string[]) {
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
    patchStoryboardMedia(canvas, target, { meta: { storyboardSources: JSON.stringify(sources) } })
}
/** Document preparation is one undo step; generation only starts in the batch confirmation. */
export function prepareStoryboardFrames(
  canvas: NodeCanvasDocument,
  id: string,
  mode: StoryboardFrameMode,
) {
  const board = boardOf(canvas, id),
    fingerprint = storyboardFingerprint(board.data.shots)
  const frameIds: string[] = [],
    generateIds: string[] = []
  const batches = mode === 'grid' ? storyboardGridBatches(board.data.shots) : []
  board.data.shots.forEach((shot) => shotPrompt(shot))
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const [index, shot] of board.data.shots.entries()) {
      const snapshot = readCanvasDocument(canvas.doc)
      const existing = findGenerated(snapshot.nodes, id, 'frame', shot.id)
      const frameId =
        existing?.id ??
        createNode(canvas, 'image', { x: 0, y: 0 }, '', {
          nodes: [{ ...board, y: board.y + index * 408 }],
          side: 'right',
          size: { width: 360, height: 240 },
        })
      const node = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === frameId)!
      if (node.type !== 'image') continue
      patchStoryboardMedia(canvas, frameId, {
        name: t('storyFlow.frameName', { index: index + 1 }),
        meta: {
          nodeKind: 'image',
          storyboardId: id,
          storyboardRole: 'frame',
          storyboardShotId: shot.id,
          storyboardFingerprint: fingerprint,
          nodePrompt: shotPrompt(shot),
        },
      })
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
        const gridId =
          existing?.id ??
          createNode(canvas, 'image', { x: 0, y: 0 }, '', {
            nodes: [board],
            side: 'right',
            size: { width: 480, height: 360 },
          })
        const grid = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === gridId)!
        if (grid.type !== 'image') continue
        patchStoryboardMedia(canvas, gridId, {
          name: t('storyFlow.gridName', { index: batches.indexOf(shots) + 1 }),
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
        })
        linkSources(canvas, gridId, [...new Set(shots.flatMap(assetIds))])
        generateIds.push(gridId)
      }
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return { frameIds, generateIds }
}

/** Video slots exist before generation, so a failed or missing shot keeps its timeline position. */
export function prepareStoryboardVideos(
  canvas: NodeCanvasDocument,
  id: string,
  draft: VideoDraft,
  options: readonly VideoModelOption[],
) {
  const board = boardOf(canvas, id),
    snapshot = readCanvasDocument(canvas.doc)
  const option =
    options.find((option) => option.modelId === draft.model && option.support.firstFrame) ??
    options.find((option) => option.support.firstFrame)
  if (!option) throw new StoryboardFlowError(t('storyFlow.noFirstFrameModel', {}))
  const frames = board.data.shots.map((shot) => findGenerated(snapshot.nodes, id, 'frame', shot.id))
  if (
    frames.some(
      (frame) =>
        frame?.type !== 'image' ||
        !frame.data.fileId ||
        !canvasMainResult(canvas.doc, frame.id)?.inputFingerprint ||
        canvasResultIsStale(canvas.doc, frame.id) ||
        frame.data.meta?.storyboardFingerprint !== storyboardFingerprint(board.data.shots),
    )
  )
    throw new StoryboardFlowError(t('storyFlow.framesMissing', {}))
  board.data.shots.forEach((shot) => shotPrompt(shot, true))
  const videoIds: string[] = [],
    timelineIds: string[] = []
  const durations = new Map<string, number>()
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const [index, shot] of board.data.shots.entries()) {
      const frame = frames[index]!,
        existing = findGenerated(readCanvasDocument(canvas.doc).nodes, id, 'video', shot.id)
      const videoId =
        existing?.id ??
        createNode(canvas, 'video', { x: 0, y: 0 }, '', { nodes: [frame], side: 'right' })
      const node = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === videoId)!
      if (node.type !== 'image' && node.type !== 'video') continue
      const videoDraft = clampDraftToSupport(
        {
          ...draft,
          model: option.modelId,
          ...clampVideoPreset(nodeVideoSupport(option.support, 'first'), {
            ...draft,
            duration: shot.durationSeconds ?? draft.duration,
          }),
        },
        nodeVideoSupport(option.support, 'first'),
      )
      patchStoryboardMedia(canvas, videoId, {
        name: t('storyFlow.videoName', { index: index + 1 }),
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
      })
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
        seconds + duration <= FILM_MAX_SECONDS
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
        createNode(canvas, 'timeline', { x: 0, y: 0 }, '', {
          nodes: videos.filter((node) => chunk.includes(node.id)),
          side: 'right',
        })
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
  canvas.undo.stopCapturing()
  return { videoIds, timelineIds }
}
