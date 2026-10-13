import {
  type CanvasOrigin,
  type CanvasResult,
  type CanvasResultDisplay,
  cacheCanvasResultDisplay,
  canvasMainResult,
  canvasOrigin,
  canvasResults,
  chooseCanvasResult,
  connectCanvasNodes,
  readCanvasDocument,
  recordCanvasResult,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { getImageDimensions } from '../../../lib/canvasImage'
import { awaitQueueOutputs, queueOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { getAllTasks } from '../../../lib/db'
import { loadImageOriginal } from '../../../lib/imageSource'
import { videoOutputFrame } from '../../agent/lib/artifactSource'
import { blankVideoPoster } from '../../agent/lib/videoPoster'
import type { CanvasEditor } from './editor'
import { fileToDataUrl } from './importImages'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

const system = canvasOrigin('system', 'node-result')
const pixels = new WeakMap<Y.Doc, Map<string, string>>()
const selections = new WeakMap<Y.Doc, Map<string, number>>()

function sourceKey(source: CanvasResult['source']): string {
  if (source.type === 'file') return JSON.stringify(['file', source.fileId])
  if (source.type === 'media') return JSON.stringify(['media', source.mediaId])
  return JSON.stringify([source.type, source.taskId, source.outputIndex])
}

// Adoption happens in the synchronous generation-open hook. Use the same identity on both devices.
function baselineId(nodeId: string, source: CanvasResult['source']): string {
  const key = JSON.stringify([nodeId, sourceKey(source)])
  let a = 0x811c9dc5,
    b = 0x9e3779b9
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193)
    b = Math.imul(b ^ key.charCodeAt(i), 0x85ebca6b)
  }
  return `baseline:${key.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

function mediaNode(doc: Y.Doc, id: string) {
  const node = readCanvasDocument(doc).nodes.find((n) => n.id === id)
  return node?.type === 'image' || node?.type === 'video' ? node : undefined
}

/** Preserve imported/uploaded or pre-migration output as the first candidate before regeneration. */
export function adoptNodeResult(doc: Y.Doc, nodeId: string): void {
  const node = mediaNode(doc, nodeId)
  if (
    !node ||
    canvasMainResult(doc, nodeId) ||
    (!node.data.fileId && !node.data.mediaId && node.type !== 'video')
  )
    return
  const result: CanvasResult = {
    id: crypto.randomUUID(),
    nodeId,
    kind: node.type,
    createdAt: Date.now() - 1,
    source:
      node.type === 'video'
        ? {
            type: 'queue',
            taskId: node.data.video.taskId,
            outputIndex: node.data.video.outputIndex,
          }
        : node.data.mediaId
          ? { type: 'media', mediaId: node.data.mediaId }
          : { type: 'file', fileId: node.data.fileId! },
  }
  result.id = baselineId(nodeId, result.source)
  recordCanvasResult(doc, result, system)
  chooseCanvasResult(doc, nodeId, result.id, { data: node.data }, system)
}

export async function recordNodeOutput(
  doc: Y.Doc,
  input: Omit<CanvasResult, 'id'>,
  dataUrl?: string,
): Promise<CanvasResult | undefined> {
  if (!mediaNode(doc, input.nodeId)) return undefined
  let result = canvasResults(doc, input.nodeId).find(
    (r) => sourceKey(r.source) === sourceKey(input.source),
  )
  if (!result) {
    const key = new TextEncoder().encode(JSON.stringify([input.nodeId, sourceKey(input.source)]))
    const hash = await crypto.subtle.digest('SHA-256', key)
    if (doc.isDestroyed || !mediaNode(doc, input.nodeId)) return undefined
    const id = `result:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    result = { ...input, id }
    recordCanvasResult(doc, result, system)
  }
  if (dataUrl) {
    let cache = pixels.get(doc)
    if (!cache) {
      cache = new Map()
      pixels.set(doc, cache)
    }
    cache.set(result.id, dataUrl)
  }
  return result
}

async function imageSource(
  editor: CanvasEditor,
  doc: Y.Doc,
  result: CanvasResult,
): Promise<string> {
  const display = result.display
  if (display?.mediaId) return `aip-media:${display.mediaId}`
  if (display?.fileId && editor.doc.files[display.fileId]) return editor.doc.files[display.fileId]!
  const cached = pixels.get(doc)?.get(result.id)
  if (cached) return cached
  const source = result.source
  if (source.type === 'media') return `aip-media:${source.mediaId}`
  if (source.type === 'file') {
    const stored = editor.doc.files[source.fileId]
    if (stored) return stored
  } else if (source.type === 'queue') {
    const response = await authenticatedBffFetch(queueOutputUrl(source.taskId, source.outputIndex))
    if (!response.ok) throw new Error('candidate_expired')
    const blob = await response.blob()
    return fileToDataUrl(new File([blob], 'candidate', { type: blob.type }))
  } else if (source.type === 'local') {
    const task = (await getAllTasks()).find((task) => task.id === source.taskId)
    const id = task?.outputImages[source.outputIndex]
    const stored = id ? await loadImageOriginal(id) : undefined
    if (stored) return stored
  }
  throw new Error('candidate_expired')
}

async function prepareResult(
  editor: CanvasEditor,
  doc: Y.Doc,
  result: CanvasResult,
  video?: CanvasResultDisplay['video'],
): Promise<{ data: CanvasResultDisplay; width: number; height: number } | null> {
  let source: string
  let display: CanvasResultDisplay = {}
  if (result.kind === 'video') {
    const ref = result.source
    if (ref.type !== 'queue') throw new Error('candidate_expired')
    const videoRef = video ??
      result.display?.video ?? { taskId: ref.taskId, outputIndex: ref.outputIndex }
    if (!video && !videoRef.mediaId) {
      const outputs = await awaitQueueOutputs(ref.taskId)
      if (!outputs.some((output) => output.index === ref.outputIndex))
        throw new Error('candidate_expired')
    }
    source =
      result.display?.fileId || result.display?.mediaId
        ? await imageSource(editor, doc, result)
        : ((await videoOutputFrame(videoRef)) ?? blankVideoPoster({}))
    display.video = videoRef
  } else {
    source = await imageSource(editor, doc, result)
  }
  const resolved = await resolveMediaSource(source, 'original', true)
  const dimensions = await getImageDimensions(resolved)
  if (doc.isDestroyed) return null
  const node = mediaNode(doc, result.nodeId)
  if (!node) return null
  const mediaId =
    result.display?.mediaId ?? (result.source.type === 'media' ? result.source.mediaId : undefined)
  display = {
    ...display,
    fileId: editor.doc.cacheBitmap(source, mediaId ? `cloud-${mediaId}` : undefined),
    ...(mediaId ? { mediaId } : {}),
    naturalWidth: dimensions.width,
    naturalHeight: dimensions.height,
  }
  const scale = Math.max(1, node.width) / dimensions.width
  return { data: display, width: dimensions.width * scale, height: dimensions.height * scale }
}

/** Resolve pixels first; a failed/expired candidate leaves the current main result unchanged. */
export async function selectNodeResult(
  editor: CanvasEditor,
  doc: Y.Doc,
  resultId: string,
  origin: CanvasOrigin,
  video?: CanvasResultDisplay['video'],
): Promise<boolean> {
  const result = canvasResults(doc).find((result) => result.id === resultId)
  if (!result || !mediaNode(doc, result.nodeId)) return false
  let epochs = selections.get(doc)
  if (!epochs) {
    epochs = new Map()
    selections.set(doc, epochs)
  }
  const epoch = (epochs.get(result.nodeId) ?? 0) + 1
  epochs.set(result.nodeId, epoch)
  const initialMain = canvasMainResult(doc, result.nodeId)?.id
  const initialNode = doc.getMap<Y.Map<unknown>>('nodes').get(result.nodeId)
  const content = () => {
    const node = doc.getMap<Y.Map<unknown>>('nodes').get(result.nodeId)
    const data = node?.get('data') as CanvasResultDisplay | undefined
    return JSON.stringify([node?.get('type'), data?.fileId, data?.mediaId, data?.video])
  }
  const initialContent = content()
  const projection = await prepareResult(editor, doc, result, video)
  if (
    !projection ||
    doc.isDestroyed ||
    epochs.get(result.nodeId) !== epoch ||
    doc.getMap('nodes').get(result.nodeId) !== initialNode ||
    canvasMainResult(doc, result.nodeId)?.id !== initialMain ||
    content() !== initialContent
  )
    return false
  return chooseCanvasResult(doc, result.nodeId, result.id, projection, origin)
}

/** Load every candidate before inserting anything; one undo removes the entire spread. */
export async function spreadNodeResults(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  nodeId: string,
): Promise<string[]> {
  const results = canvasResults(canvas.doc, nodeId)
  if (results.length < 2) return []
  const prepared: {
    result: CanvasResult
    projection: NonNullable<Awaited<ReturnType<typeof prepareResult>>>
  }[] = []
  for (const result of results) {
    const projection = await prepareResult(editor, canvas.doc, result)
    if (!projection) return []
    prepared.push({ result, projection })
  }
  const source = mediaNode(canvas.doc, nodeId)
  if (!source || canvas.doc.isDestroyed) return []
  const incoming = readCanvasDocument(canvas.doc).edges.filter((edge) => edge.target === nodeId)
  const ids: string[] = []
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const { result, projection } of prepared) {
      const id = createNode(canvas, result.kind, { x: source.x, y: source.y }, '', {
        nodes: [source],
        side: 'right',
        size: projection,
      })
      cacheCanvasResultDisplay(canvas.doc, result.id, projection.data, system)
      const retained = canvasResults(canvas.doc, nodeId).find((item) => item.id === result.id)!
      const copy = { ...retained, id: crypto.randomUUID(), nodeId: id }
      recordCanvasResult(canvas.doc, copy, system)
      updateCanvasNode(
        canvas.doc,
        id,
        { data: { name: source.data.name, meta: source.data.meta } },
        canvas.origin,
      )
      chooseCanvasResult(canvas.doc, id, copy.id, projection, canvas.origin)
      for (const edge of incoming)
        connectCanvasNodes(canvas.doc, { source: edge.source, target: id }, canvas.origin)
      ids.push(id)
    }
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return ids
}
