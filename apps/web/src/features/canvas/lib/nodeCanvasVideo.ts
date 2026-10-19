import type { StageAuthorizationSubmission } from '@image-playground/shared'
import {
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeJobs,
  canvasOrigin,
  finishCanvasNodeJob,
  readCanvasDocument,
  setCanvasNodeJob,
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
import { videoRejectionText } from '../../video/lib/labels'
import { useVideoStore } from '../../video/store'
import type { VideoDraft } from '../../video/types'
import type { CanvasEditor } from './editor'
import type { NodeReference } from './nodeCanvasFlow'
import { adoptNodeResult, recordNodeOutput, selectNodeResult } from './nodeCanvasResults'
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
async function settle(
  editor: CanvasEditor,
  doc: Y.Doc,
  id: string,
  requestId: string,
  generation: VideoGenerationRecord,
  jobId: string,
  inputFingerprint?: string,
  initialResultId?: string,
): Promise<void> {
  const outputs = await awaitQueueOutputs(requestId)
  if (!outputs.length) throw new Error(i18next.t('nodes.generationFailed', { ns: 'canvas' }))
  const results = await Promise.all(
    outputs.map((output) =>
      recordNodeOutput(doc, {
        nodeId: id,
        kind: 'video',
        source: { type: 'queue', taskId: requestId, outputIndex: output.index },
        display: { video: { taskId: requestId, outputIndex: output.index, generation } },
        createdAt: Date.now() + output.index,
        ...(inputFingerprint ? { inputFingerprint } : {}),
      }),
    ),
  )
  if (
    results[0] &&
    canvasMainResult(doc, id)?.id === initialResultId &&
    (initialResultId || !mediaNode(doc, id)?.data.fileId)
  )
    await selectNodeResult(editor, doc, results[0].id, origin, {
      taskId: requestId,
      outputIndex: outputs[0]!.index,
      generation,
    })
  finishCanvasNodeJob(doc, jobId, origin)
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
  stageAuthorization?: StageAuthorizationSubmission,
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
  adoptNodeResult(doc, id)
  for (const job of canvasNodeJobs(doc, id))
    if (job.status !== 'loading') finishCanvasNodeJob(doc, job.id, origin)
  const meta = {
    nodeVideo: true as const,
    prompt,
    generation,
    clientRequestId: crypto.randomUUID(),
    inputFingerprint: canvasInputFingerprint(doc, id),
    initialResultId: canvasMainResult(doc, id)?.id,
  }
  const jobId = meta.clientRequestId
  setCanvasNodeJob(
    doc,
    { id: jobId, nodeId: id, createdAt: Date.now(), status: 'loading', message: '', meta },
    origin,
  )
  void superviseGeneration(
    id,
    {
      delivered() {},
      failed(_nodeId, failure) {
        const job = canvasNodeJobs(doc).find((job) => job.id === jobId)
        if (job) setCanvasNodeJob(doc, { ...job, status: 'error', message: failure.text }, origin)
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
        stageAuthorization,
      })
      claimResume(doc, id, requestId)
      const job = canvasNodeJobs(doc).find((job) => job.id === jobId)
      if (job) setCanvasNodeJob(doc, { ...job, meta: { ...meta, bffRequestId: requestId } }, origin)
      notifyPrivateSubmissionAccepted()
      await settle(
        editor,
        doc,
        id,
        requestId,
        generation,
        jobId,
        meta.inputFingerprint,
        meta.initialResultId,
      )
    },
  )
  return true
}
export function resumeNodeVideos(editor: CanvasEditor, doc: Y.Doc, markUnrecoverable = true): void {
  for (const node of readCanvasDocument(doc).nodes) {
    if ((node.type !== 'image' && node.type !== 'video') || canvasNodeJobs(doc, node.id).length)
      continue
    const pending = node.data.pending
    if (pending?.type !== 'placeholder' || pending.status !== 'loading') continue
    const meta = pending.meta as {
      nodeVideo?: boolean
      prompt?: string
      bffRequestId?: string
      clientRequestId?: string
      generation?: VideoGenerationRecord
    }
    if (!meta.nodeVideo) continue
    const jobId = meta.clientRequestId ?? meta.bffRequestId ?? `legacy:${node.id}`
    setCanvasNodeJob(
      doc,
      {
        id: jobId,
        nodeId: node.id,
        createdAt: Date.now(),
        status: 'loading',
        message: '',
        meta: {
          nodeVideo: true,
          prompt: meta.prompt ?? '',
          clientRequestId: jobId,
          ...(meta.bffRequestId ? { bffRequestId: meta.bffRequestId } : {}),
          ...(meta.generation ? { generation: meta.generation } : {}),
        },
      },
      origin,
    )
  }
  for (const job of canvasNodeJobs(doc)) {
    if (!job.meta.nodeVideo || job.status !== 'loading' || !mediaNode(doc, job.nodeId)) continue
    const { bffRequestId, generation, inputFingerprint, initialResultId } = job.meta
    if (!bffRequestId || !generation) {
      if (markUnrecoverable)
        setCanvasNodeJob(
          doc,
          {
            ...job,
            status: 'stale',
            message: i18next.t('placeholder.unconfirmed', { ns: 'canvas' }),
          },
          origin,
        )
      continue
    }
    if (!claimResume(doc, job.nodeId, bffRequestId)) continue
    void superviseGeneration(
      job.nodeId,
      {
        delivered() {},
        failed(_id, failure) {
          setCanvasNodeJob(doc, { ...job, status: 'error', message: failure.text }, origin)
        },
      },
      () =>
        settle(
          editor,
          doc,
          job.nodeId,
          bffRequestId,
          generation,
          job.id,
          inputFingerprint,
          initialResultId,
        ),
    )
  }
}
