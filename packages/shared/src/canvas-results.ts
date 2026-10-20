import type * as Y from 'yjs'
import { type CanvasOrigin, type ImageNodeData, readCanvasDocument } from './canvas-document'
import { canvasFingerprint } from './canvas-fingerprint'
import { storyboardFingerprint } from './canvas-storyboard'
import type { ProjectVideoRef } from './project-protocol'

export type CanvasResultDisplay = Pick<
  ImageNodeData,
  'fileId' | 'mediaId' | 'naturalWidth' | 'naturalHeight'
> & { video?: ProjectVideoRef }

/** Candidates contain references only. Unselected queue outputs keep their original retention. */
export interface CanvasResult {
  id: string
  nodeId: string
  kind: 'image' | 'video'
  source:
    | { type: 'queue' | 'local'; taskId: string; outputIndex: number }
    | { type: 'media'; mediaId: string }
    | { type: 'file'; fileId: string }
  createdAt: number
  assetViewLabel?: 'sheet'
  inputFingerprint?: string
  /** Chosen or spread at least once; unchosen video metadata alone is not adoption. */
  adopted?: true
  /** Display cache for a result that has been chosen; cloud preparation promotes its bitmap. */
  display?: CanvasResultDisplay
}

export function canvasResults(doc: Y.Doc, nodeId?: string): CanvasResult[] {
  return [...doc.getMap<CanvasResult>('nodeResults').values()]
    .filter((result) => nodeId === undefined || result.nodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function canvasResultMediaIds(doc: Y.Doc): string[] {
  return [
    ...new Set(
      canvasResults(doc).flatMap((result) => [
        ...(result.display?.mediaId ? [result.display.mediaId] : []),
        ...(result.display?.video?.mediaId ? [result.display.video.mediaId] : []),
        ...(result.source.type === 'media' ? [result.source.mediaId] : []),
      ]),
    ),
  ]
}

export function canvasMainResult(doc: Y.Doc, nodeId: string): CanvasResult | undefined {
  const id = doc.getMap<string>('mainResults').get(nodeId)
  const result = id ? doc.getMap<CanvasResult>('nodeResults').get(id) : undefined
  return result?.nodeId === nodeId ? result : undefined
}

/** One entry per output, not a JSON array: concurrent generations must both survive a Yjs merge. */
export function recordCanvasResult(
  doc: Y.Doc,
  result: CanvasResult,
  origin: CanvasOrigin,
): boolean {
  if (!doc.getMap('nodes').has(result.nodeId) || doc.getMap('nodeResults').has(result.id))
    return false
  doc.transact(() => doc.getMap<CanvasResult>('nodeResults').set(result.id, result), origin)
  return true
}

/** The caller resolves/promotes the reference before atomically replacing the displayed projection. */
export function chooseCanvasResult(
  doc: Y.Doc,
  nodeId: string,
  resultId: string,
  projection: {
    data: ImageNodeData & { video?: ProjectVideoRef }
    width?: number
    height?: number
  },
  origin: CanvasOrigin,
): boolean {
  const result = doc.getMap<CanvasResult>('nodeResults').get(resultId)
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
  if (
    !node ||
    !result ||
    result.nodeId !== nodeId ||
    (result.kind === 'video' && !projection.data.video)
  )
    return false
  doc.transact(() => {
    const data = projection.data as ImageNodeData & { video?: ProjectVideoRef }
    const video = retainOriginal(result.display?.video, data.video)
    const display: CanvasResultDisplay = {
      ...(data.fileId ? { fileId: data.fileId } : {}),
      ...(data.mediaId ? { mediaId: data.mediaId } : {}),
      ...(data.naturalWidth ? { naturalWidth: data.naturalWidth } : {}),
      ...(data.naturalHeight ? { naturalHeight: data.naturalHeight } : {}),
      ...(video ? { video } : {}),
    }
    doc.getMap<CanvasResult>('nodeResults').set(resultId, { ...result, adopted: true, display })
    doc.getMap<string>('mainResults').set(nodeId, resultId)
    if (projection.width !== undefined) node.set('width', projection.width)
    if (projection.height !== undefined) node.set('height', projection.height)
  }, origin)
  return true
}

/** A late poster decode must not replace a permanent original with its old queue address. */
function retainOriginal(
  previous: ProjectVideoRef | undefined,
  next: ProjectVideoRef | undefined,
): ProjectVideoRef | undefined {
  return next &&
    previous?.mediaId &&
    previous.taskId === next.taskId &&
    previous.outputIndex === next.outputIndex
    ? { ...next, mediaId: previous.mediaId }
    : next
}

/** Stable across layout, thumbnails, labels, and local/cloud cache identifiers. */
export function canvasInputFingerprint(doc: Y.Doc, nodeId: string): string {
  const snapshot = readCanvasDocument(doc)
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const inputs = snapshot.edges
    .filter((edge) => edge.target === nodeId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((edge) => {
      const node = nodes.get(edge.source)
      if (!node) return [edge.source, null]
      if (node.type === 'text') return [node.id, 'text', node.data.text]
      if (node.type === 'timeline') return [node.id, 'timeline', node.data.clips]
      if (node.type === 'storyboard') return [node.id, 'storyboard', node.data.shots]
      const result = canvasMainResult(doc, node.id)
      return [
        node.id,
        node.type,
        result?.id ??
          node.data.meta?.contentIdentity ??
          node.data.mediaId ??
          node.data.fileId ??
          null,
        node.type === 'video' ? [node.data.video.taskId, node.data.video.outputIndex] : null,
        node.data.meta?.videoTrimIn ?? null,
        node.data.meta?.videoTrimOut ?? null,
        ...(node.data.meta?.nodeKind === 'asset'
          ? [[node.data.name ?? '', node.data.meta.assetDescription ?? '']]
          : []),
      ]
    })
  const target = nodes.get(nodeId)
  const meta = target && 'meta' in target.data ? target.data.meta : undefined
  if (meta?.nodeImagePreset)
    inputs.push(['image-preset', meta.nodeImagePreset, meta.nodePrompt ?? ''])
  // Storyboard outputs also belong to the reviewed shot revision, not just its asset inputs.
  if (meta?.storyboardId && meta.storyboardRole) {
    inputs.push([
      'storyboard',
      meta.storyboardFingerprint ?? null,
      meta.nodePrompt ?? '',
      meta.storyboardGrid ?? null,
      meta.storyboardFrameIds ?? null,
      meta.storyboardFrameInputs ?? null,
    ])
    const board = nodes.get(meta.storyboardId)
    if (board?.type === 'storyboard') {
      const current = storyboardFingerprint(board.data.shots)
      if (current !== meta.storyboardFingerprint) inputs.push(['storyboard-edited', current])
    }
  }
  return canvasFingerprint(JSON.stringify(inputs))
}

export function canvasResultIsStale(doc: Y.Doc, nodeId: string): boolean {
  const previous = canvasMainResult(doc, nodeId)?.inputFingerprint
  return previous !== undefined && previous !== canvasInputFingerprint(doc, nodeId)
}

/** Promotion changes storage addresses, not pixels or result identity. */
export function promoteCanvasResultMedia(
  doc: Y.Doc,
  nodeId: string,
  fileId: string,
  mediaId: string,
  origin: CanvasOrigin,
): void {
  const result = canvasMainResult(doc, nodeId)
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
  if (!node) return
  const data = node.get('data') as ImageNodeData
  doc.transact(() => {
    if (result) promoteCanvasStoredResult(doc, result.id, fileId, mediaId, origin)
    if (data.fileId === fileId)
      node.set('data', {
        ...data,
        mediaId,
        fileId: `cloud-${mediaId}`,
        meta: {
          ...data.meta,
          contentIdentity: data.meta?.contentIdentity ?? data.mediaId ?? fileId,
        },
      })
  }, origin)
}

export function promoteCanvasStoredResult(
  doc: Y.Doc,
  resultId: string,
  fileId: string,
  mediaId: string,
  origin: CanvasOrigin,
): void {
  const result = doc.getMap<CanvasResult>('nodeResults').get(resultId)
  if (!result) return
  const display =
    result.display?.fileId === fileId
      ? { ...result.display, fileId: `cloud-${mediaId}`, mediaId }
      : result.display
  const source =
    result.source.type === 'file' && result.source.fileId === fileId
      ? { type: 'media' as const, mediaId }
      : result.source
  if (display !== result.display || source !== result.source)
    doc.transact(
      () =>
        doc
          .getMap<CanvasResult>('nodeResults')
          .set(resultId, { ...result, source, ...(display ? { display } : {}) }),
      origin,
    )
}

/** A decoded poster is a new cache entry for the same video, not a new main result. */
export function refreshCanvasResultDisplay(
  doc: Y.Doc,
  nodeId: string,
  data: CanvasResultDisplay,
  origin: CanvasOrigin,
): void {
  const result = canvasMainResult(doc, nodeId)
  if (!result) return
  const display: CanvasResultDisplay = {
    ...(data.fileId ? { fileId: data.fileId } : {}),
    ...(data.mediaId ? { mediaId: data.mediaId } : {}),
    ...(data.naturalWidth ? { naturalWidth: data.naturalWidth } : {}),
    ...(data.naturalHeight ? { naturalHeight: data.naturalHeight } : {}),
    ...(data.video ? { video: retainOriginal(result.display?.video, data.video) } : {}),
  }
  doc.transact(
    () => doc.getMap<CanvasResult>('nodeResults').set(result.id, { ...result, display }),
    origin,
  )
}

export function cacheCanvasResultDisplay(
  doc: Y.Doc,
  resultId: string,
  display: CanvasResultDisplay,
  origin: CanvasOrigin,
): void {
  const result = doc.getMap<CanvasResult>('nodeResults').get(resultId)
  if (result)
    doc.transact(
      () =>
        doc.getMap<CanvasResult>('nodeResults').set(resultId, {
          ...result,
          adopted: true,
          display: {
            ...display,
            ...(display.video
              ? { video: retainOriginal(result.display?.video, display.video) }
              : {}),
          },
        }),
      origin,
    )
}

/** Promote every retained reference to this immutable output without changing selection/history. */
export function promoteCanvasVideoMedia(
  doc: Y.Doc,
  video: ProjectVideoRef,
  mediaId: string,
  origin: CanvasOrigin,
): void {
  const matches = (ref: ProjectVideoRef | undefined) =>
    ref?.taskId === video.taskId && ref.outputIndex === video.outputIndex && !ref.mediaId
  doc.transact(() => {
    for (const node of doc.getMap<Y.Map<unknown>>('nodes').values()) {
      const data = node.get('data') as ImageNodeData & { video?: ProjectVideoRef }
      if (matches(data.video)) node.set('data', { ...data, video: { ...data.video, mediaId } })
    }
    for (const result of canvasResults(doc)) {
      if (matches(result.display?.video))
        doc.getMap<CanvasResult>('nodeResults').set(result.id, {
          ...result,
          display: { ...result.display, video: { ...result.display!.video!, mediaId } },
        })
    }
  }, origin)
}
