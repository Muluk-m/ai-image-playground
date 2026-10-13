import {
  canvasOrigin,
  connectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
  type VideoGenerationRecord,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { i18next } from '../../../i18n'
import { getStoredChannel } from '../../../lib/channels/channelStore'
import { awaitQueueOutputs, submitVideoRequest } from '../../../lib/channels/queueClient'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { superviseGeneration } from '../../../lib/generationJob'
import { notifyPrivateSubmissionAccepted } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { videoOutputFrame } from '../../agent/lib/artifactSource'
import { blankVideoPoster } from '../../agent/lib/videoPoster'
import { videoRejectionText } from '../../video/lib/labels'
import { useVideoStore } from '../../video/store'
import type { VideoDraft } from '../../video/types'
import { newElementId } from './canvasDoc'
import type { CanvasEditor } from './editor'
import type { NodeReference } from './nodeCanvasFlow'
import { canvasVideoPromptRefusal, guardAllows } from './submitVideoFromCanvas'
import { generationInputIds, inputIndices } from './videoInputs'
import { videoOptionRejection } from './videoRejection'

const origin = canvasOrigin('system', 'node-video')
const resumed = new WeakMap<Y.Doc, Set<string>>()
function claimResume(doc: Y.Doc, nodeId: string, requestId: string): boolean {
  let keys = resumed.get(doc)
  if (!keys) {
    keys = new Set()
    resumed.set(doc, keys)
  }
  const key = `${nodeId}:${requestId}`
  if (keys.has(key)) return false
  keys.add(key)
  return true
}
function mediaNode(doc: Y.Doc, id: string) {
  const node = readCanvasDocument(doc).nodes.find((n) => n.id === id)
  return node && (node.type === 'image' || node.type === 'video') ? node : undefined
}
function pending(doc: Y.Doc, id: string, status: string, message: string, meta: object) {
  const node = mediaNode(doc, id)
  if (node)
    updateCanvasNode(
      doc,
      id,
      { data: { ...node.data, pending: { type: 'placeholder', status, message, meta } } },
      origin,
    )
}
async function settle(
  editor: CanvasEditor,
  doc: Y.Doc,
  id: string,
  requestId: string,
  generation: VideoGenerationRecord,
): Promise<void> {
  const [output] = await awaitQueueOutputs(requestId)
  if (!output) throw new Error(i18next.t('nodes.generationFailed', { ns: 'canvas' }))
  const source = { taskId: requestId, outputIndex: output.index }
  const dataUrl =
    (await videoOutputFrame(source)) ??
    blankVideoPoster({ width: output.width, height: output.height })
  const node = mediaNode(doc, id)
  if (!node) return
  const video = { ...source, generation }
  const ratio = output.width && output.height ? output.width / output.height : 16 / 9
  const width = node.width
  const height = width / ratio
  if (editor.doc.getElement(id)?.type === 'image')
    editor.doc.replaceImageBitmap(id, dataUrl, { video, width, height })
  else editor.placeImages([{ id, dataUrl, x: node.x, y: node.y, width, height, video }])
  const settled = mediaNode(doc, id)
  if (settled)
    updateCanvasNode(
      doc,
      id,
      {
        width,
        height,
        data: {
          ...settled.data,
          pending: undefined,
          meta: { ...node.data.meta, ...settled.data.meta },
        },
      },
      origin,
    )
}
export function submitNodeVideo(
  editor: CanvasEditor,
  doc: Y.Doc,
  id: string,
  prompt: string,
  refs: readonly NodeReference[],
  roles: Record<string, string>,
  files: Readonly<Record<string, string>>,
  nodeDraft?: VideoDraft,
): boolean {
  const node = mediaNode(doc, id)
  if (!node) return false
  if (node.data.pending?.type === 'placeholder' && node.data.pending.status === 'loading')
    return false
  const reject = (text: string) => {
    useStore.getState().showToast(text, 'error')
    return false
  }
  if (refs.some((ref) => ref.kind === 'video'))
    return reject(i18next.t('nodes.videoInputUnsupported', { ns: 'canvas' }))
  const draft = nodeDraft ?? useVideoStore.getState().draft
  const option = videoModelOptions().find((o) => o.modelId === draft.model)
  if (!option) return reject(i18next.t('nodes.noVideoModel', { ns: 'canvas' }))
  if (!prompt.trim()) return reject(i18next.t('store.emptyPrompt', { ns: 'video' }))
  const images = refs.filter((ref) => ref.kind === 'image')
  const first = images.find((ref) => roles[ref.id] === 'first')
  const last = images.find((ref) => roles[ref.id] === 'last')
  const referenceIds = images
    .filter((ref) => !['first', 'last'].includes(roles[ref.id] ?? ''))
    .map((ref) => ref.id)
  const generation: VideoGenerationRecord = {
    model: option.modelId,
    duration: draft.duration,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    ...(draft.voices?.length ? { voices: draft.voices } : {}),
    ...(first ? { firstFrameId: first.id } : {}),
    ...(last ? { lastFrameId: last.id } : {}),
    ...(referenceIds.length ? { referenceIds } : {}),
  }
  const video = {
    duration_seconds: generation.duration,
    aspect_ratio: generation.aspectRatio,
    resolution: generation.resolution,
    ...inputIndices(generation),
    ...(generation.voices?.length ? { voices: [...generation.voices] } : {}),
  }
  const invalid = videoOptionRejection(option.modelId, video, images.length)
  if (invalid) return reject(videoRejectionText(invalid))
  const tooLong = canvasVideoPromptRefusal(option.modelId, prompt)
  if (tooLong) return reject(tooLong)
  const byId = new Map(images.map((ref) => [ref.id, ref.fileId ? files[ref.fileId] : undefined]))
  const inputs = generationInputIds(generation).map((id) => byId.get(id))
  if (inputs.some((input) => !input))
    return reject(i18next.t('nodes.mediaMissing', { ns: 'canvas' }))
  if (!guardAllows(generation)) return false
  let outputId = id
  if (node.data.fileId) {
    outputId = newElementId()
    const snapshot = readCanvasDocument(doc)
    const x = node.x + node.width + 100
    let y = node.y
    while (
      snapshot.nodes.some(
        (n) =>
          x < n.x + n.width + 24 &&
          x + node.width + 24 > n.x &&
          y < n.y + n.height + 24 &&
          y + node.height + 24 > n.y,
      )
    )
      y += node.height + 88
    insertCanvasNode(
      doc,
      {
        id: outputId,
        type: 'image',
        x,
        y,
        width: node.width,
        height: node.height,
        data: { meta: { ...node.data.meta, nodeKind: 'video' } },
      },
      origin,
    )
    for (const edge of snapshot.edges.filter((edge) => edge.target === id))
      connectCanvasNodes(doc, { source: edge.source, target: outputId }, origin)
  }
  const meta = { nodeVideo: true, prompt, generation, clientRequestId: crypto.randomUUID() }
  pending(doc, outputId, 'loading', '', meta)
  void superviseGeneration(
    outputId,
    {
      delivered() {},
      failed(nodeId, failure) {
        pending(doc, nodeId, 'error', failure.text, meta)
        useStore.getState().showToast(failure.text, 'error')
      },
    },
    async () => {
      const channel = getStoredChannel(option.channelId)
      if (!channel) throw new Error(i18next.t('nodes.noVideoModel', { ns: 'canvas' }))
      const requestId = await submitVideoRequest({
        channel,
        model: option.modelId,
        prompt,
        video,
        inputImageDataUrls: await Promise.all(
          (inputs as string[]).map((source) => resolveMediaSource(source, 'original', true)),
        ),
        clientRequestId: meta.clientRequestId,
      })
      claimResume(doc, outputId, requestId)
      pending(doc, outputId, 'loading', '', { ...meta, bffRequestId: requestId })
      notifyPrivateSubmissionAccepted()
      await settle(editor, doc, outputId, requestId, generation)
    },
  )
  return true
}
export function resumeNodeVideos(editor: CanvasEditor, doc: Y.Doc, markUnrecoverable = true): void {
  for (const node of readCanvasDocument(doc).nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue
    const job = node.data.pending
    if (job?.type !== 'placeholder' || job.status !== 'loading') continue
    const meta = job.meta as {
      nodeVideo?: boolean
      bffRequestId?: string
      generation?: VideoGenerationRecord
    }
    if (!meta.nodeVideo) continue
    if (!meta.bffRequestId || !meta.generation) {
      if (!markUnrecoverable) continue
      pending(doc, node.id, 'stale', i18next.t('placeholder.unconfirmed', { ns: 'canvas' }), meta)
      continue
    }
    if (!claimResume(doc, node.id, meta.bffRequestId)) continue
    const requestId = meta.bffRequestId,
      generation = meta.generation
    void superviseGeneration(
      node.id,
      {
        delivered() {},
        failed(id, failure) {
          pending(doc, id, 'error', failure.text, meta)
        },
      },
      () => settle(editor, doc, node.id, requestId, generation),
    )
  }
}
