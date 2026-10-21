import type { StageAuthorizationSubmission } from '@image-playground/shared'
import {
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeJobs,
  canvasOrigin,
  finishCanvasNodeJob,
  type PendingGeneration,
  readCanvasDocument,
  setCanvasNodeJob,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { getImageDimensions } from '../../../lib/canvasImage'
import { type GenerationSink, resumeGeneration, startGeneration } from '../../../lib/generationJob'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { addCompletedCanvasTask, type CanvasProfileSnapshot, useStore } from '../../../store'
import type { AppSettings, TaskParams } from '../../../types'
import type { CanvasEditor } from './editor'
import { fileToDataUrl } from './importImages'
import { saveAssetNodeResult } from './nodeAssetGeneration'
import { adoptNodeResult, recordNodeOutput, selectNodeResult } from './nodeCanvasResults'
import { persistLocalNodeResults } from './nodeResultPersistence'

const generationOrigin: CanvasOrigin = canvasOrigin('system', 'node-generation')
const resumedDocs = new WeakMap<Y.Doc, Set<string>>()
function claimResume(doc: Y.Doc, nodeId: string, requestId: string): boolean {
  let keys = resumedDocs.get(doc)
  if (!keys) {
    keys = new Set()
    resumedDocs.set(doc, keys)
  }
  const key = `${nodeId}:${requestId}`
  if (keys.has(key)) return false
  keys.add(key)
  return true
}

interface NodeJobContext {
  source: 'builtin-edge' | 'user-byok'
  assetViewLabel?: 'sheet'
  prompt: string
  profileView: CanvasProfileSnapshot
}

interface NodeJobHandle {
  assetViewLabel?: 'sheet'
  jobId: string
  inputFingerprint?: string
  initialResultId?: string
  requestId?: string
  clientRequestId?: string
  nodeId: string
  prompt: string
  params: TaskParams
  startedAt?: number
  profileView?: CanvasProfileSnapshot
}

interface NodeGenerationMeta {
  nodeGeneration: true
  prompt: string
  source: 'builtin-edge' | 'user-byok'
  clientRequestId?: string
  bffRequestId?: string
  params?: TaskParams
}

function imageNode(doc: Y.Doc, id: string) {
  const node = readCanvasDocument(doc).nodes.find((one) => one.id === id)
  return node?.type === 'image' ? node : undefined
}

function loading(pending: PendingGeneration | undefined): boolean {
  if (!pending) return false
  if (pending.type === 'generation') return !pending.errorCode
  return pending.status === 'loading'
}

function generationMeta(pending: PendingGeneration | undefined): NodeGenerationMeta | undefined {
  if (!pending || pending.type !== 'placeholder') return undefined
  const meta = pending.meta as Partial<NodeGenerationMeta>
  if (meta.nodeGeneration !== true || typeof meta.prompt !== 'string') return undefined
  if (meta.source !== 'builtin-edge' && meta.source !== 'user-byok') return undefined
  return meta as NodeGenerationMeta
}

/** 把一张位图写进这个节点。已有旧元素就换图，否则用同一个 id 放进旧存档，同步会填上 fileId。 */
async function putBitmapOnNode(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
  dataUrl: string,
  name?: string,
  onlyIfEmpty = false,
): Promise<boolean> {
  const node = imageNode(doc, nodeId)
  if (!node) return false
  let naturalWidth: number | undefined
  let naturalHeight: number | undefined
  try {
    const dims = await getImageDimensions(dataUrl)
    naturalWidth = dims.width
    naturalHeight = dims.height
  } catch {
    // Intrinsic metadata is optional; a decode must never change the frame.
  }
  const current = imageNode(doc, nodeId)
  if (!current || (onlyIfEmpty && (current.data.fileId || current.data.mediaId))) return false
  const patch = {
    width: current.width,
    height: current.height,
    ...(name ? { name } : {}),
    ...(naturalWidth ? { naturalWidth, naturalHeight } : {}),
  }
  if (editor.doc.getElement(nodeId)?.type === 'image') {
    editor.doc.replaceImageBitmap(nodeId, dataUrl, patch)
  } else {
    editor.placeImages([
      {
        id: nodeId,
        dataUrl,
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
        ...(name ? { name } : {}),
        ...(naturalWidth ? { naturalWidth, naturalHeight } : {}),
      },
    ])
  }
  // Preserve the empty card's metadata when the legacy bitmap bridge fills it.
  const settled = imageNode(doc, nodeId)
  if (settled)
    updateCanvasNode(
      doc,
      nodeId,
      {
        data: { ...settled.data, meta: { ...node.data.meta, ...settled.data.meta } },
      },
      generationOrigin,
    )
  return true
}

function nodeGenerationSink(
  editor: CanvasEditor,
  doc: Y.Doc,
  primaryId: string,
): GenerationSink<NodeJobHandle, NodeJobContext> {
  let selectFirst = true
  return {
    open(unit): NodeJobHandle {
      adoptNodeResult(doc, primaryId)
      for (const job of canvasNodeJobs(doc, primaryId))
        if (job.status !== 'loading') finishCanvasNodeJob(doc, job.id, generationOrigin)
      const inputFingerprint = canvasInputFingerprint(doc, primaryId)
      const startedAt = Date.now()
      const initialResultId = canvasMainResult(doc, primaryId)?.id
      setCanvasNodeJob(
        doc,
        {
          id: unit.clientRequestId,
          nodeId: primaryId,
          createdAt: startedAt,
          status: 'loading',
          message: '',
          meta: {
            nodeGeneration: true,
            prompt: unit.context.prompt,
            source: unit.context.source,
            clientRequestId: unit.clientRequestId,
            params: { ...unit.params },
            inputFingerprint,
            ...(unit.context.assetViewLabel ? { assetViewLabel: unit.context.assetViewLabel } : {}),
            ...(initialResultId ? { initialResultId } : {}),
          },
        },
        generationOrigin,
      )
      return {
        jobId: unit.clientRequestId,
        nodeId: primaryId,
        clientRequestId: unit.clientRequestId,
        prompt: unit.context.prompt,
        params: unit.params,
        profileView: unit.context.profileView,
        startedAt,
        inputFingerprint,
        assetViewLabel: unit.context.assetViewLabel,
        initialResultId,
      }
    },
    accepted(handle, reference) {
      if (reference.kind !== 'queue') return
      handle.requestId = reference.requestId
      claimResume(doc, handle.nodeId, reference.requestId)
      const job = canvasNodeJobs(doc).find((job) => job.id === handle.jobId)
      if (job)
        setCanvasNodeJob(
          doc,
          { ...job, meta: { ...job.meta, bffRequestId: reference.requestId } },
          generationOrigin,
        )
    },
    progress() {},
    async delivered(handle, result) {
      const images = result.images.filter((item): item is string => Boolean(item))
      if (!images.length) throw new Error(i18next.t('placeholder.failed', { ns: 'canvas' }))
      const taskId = handle.requestId ?? handle.clientRequestId ?? handle.jobId
      const history = {
        id: `canvas:${taskId}`,
        prompt: handle.prompt,
        params: handle.params,
        images,
        ...(handle.startedAt ? { elapsed: Date.now() - handle.startedAt } : {}),
        ...(handle.profileView ? { profile: handle.profileView } : {}),
      }
      if (handle.requestId) await addCompletedCanvasTask(history)
      else await persistLocalNodeResults(doc, handle.nodeId, history)
      const results = await Promise.all(
        images.map((dataUrl, outputIndex) =>
          recordNodeOutput(
            doc,
            {
              nodeId: handle.nodeId,
              kind: 'image',
              ...(handle.assetViewLabel ? { assetViewLabel: handle.assetViewLabel } : {}),
              createdAt: (handle.startedAt ?? Date.now()) + outputIndex,
              source: {
                type: handle.requestId ? 'queue' : 'local',
                taskId: handle.requestId ?? `canvas:${taskId}`,
                outputIndex,
              },
              ...(handle.inputFingerprint ? { inputFingerprint: handle.inputFingerprint } : {}),
            },
            dataUrl,
          ),
        ),
      )
      if (
        selectFirst &&
        results[0] &&
        canvasMainResult(doc, handle.nodeId)?.id === handle.initialResultId &&
        (handle.initialResultId || !imageNode(doc, handle.nodeId)?.data.fileId)
      ) {
        selectFirst = false
        const selected = await selectNodeResult(editor, doc, results[0].id, generationOrigin)
        if (selected && imageNode(doc, handle.nodeId)?.data.meta?.nodeKind === 'asset') {
          try {
            await saveAssetNodeResult(editor, doc, handle.nodeId)
          } catch {
            useStore
              .getState()
              .showToast(i18next.t('nodes.assetSaveFailed', { ns: 'canvas' }), 'error')
          }
        }
      }
      finishCanvasNodeJob(doc, handle.jobId, generationOrigin)
    },
    failed(handle, failure) {
      const job = canvasNodeJobs(doc).find((job) => job.id === handle.jobId)
      if (job)
        setCanvasNodeJob(doc, { ...job, status: 'error', message: failure.text }, generationOrigin)
      useStore.getState().showToast(failure.text, 'error')
    },
  }
}

/**
 * 往这张图片节点里生成。参考图和已经拼好的提示词由调用方给出。
 * 门禁没过返回 false，转圈不会出现。
 */
export function submitNodeImage(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
  prompt: string,
  inputImageDataUrls: string[],
  edit?: { maskDataUrl?: string },
  assetViewLabel?: 'sheet',
  configuration?: {
    settings: AppSettings
    params: TaskParams
    stageAuthorization?: StageAuthorizationSubmission
  },
): boolean {
  const node = imageNode(doc, nodeId)
  if (!node || loading(node.data.pending)) return false
  if (!prompt.trim() && inputImageDataUrls.length === 0) return false
  if (inputImageDataUrls.length > API_MAX_IMAGES) {
    useStore
      .getState()
      .showToast(i18next.t('submit.tooManyInputs', { ns: 'canvas', max: API_MAX_IMAGES }), 'error')
    return false
  }
  const settings = configuration?.settings ?? useStore.getState().settings
  const profile = getActiveApiProfile(settings)
  const view = clientProfileToApiProfile(profile)
  const params = {
    ...(configuration?.params ?? useStore.getState().params),
    ...(edit ? { n: 1 } : {}),
  }
  const handles = startGeneration<NodeJobHandle, NodeJobContext>(
    {
      settings,
      outputRetention: 'candidate',
      stageAuthorization: configuration?.stageAuthorization,
      profile,
      params,
      variants: [
        {
          prompt,
          inputImageDataUrls,
          ...(edit?.maskDataUrl ? { maskDataUrl: edit.maskDataUrl } : {}),
          context: {
            source: profile.source,
            prompt,
            assetViewLabel,
            profileView: {
              apiProvider: view.provider,
              apiProfileId: view.id,
              apiProfileName: view.name,
              apiModel: view.model,
            },
          },
        },
      ],
    },
    nodeGenerationSink(editor, doc, nodeId),
  )
  return handles.length > 0
}

/** 上传的文件填进这张卡，不另起一个节点。 */
export async function fillImageNode(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
  file: File,
): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  await putBitmapOnNode(editor, doc, nodeId, dataUrl, file.name)
}

/**
 * 刷新后把还在转的节点接回去。没有可续的请求就标成失效，免得永远转圈。
 */
export function resumeNodeGenerations(
  editor: CanvasEditor,
  doc: Y.Doc,
  markUnrecoverable = true,
): void {
  // Adopt old single-request placeholders; new fan-out requests have independent entries.
  for (const node of readCanvasDocument(doc).nodes) {
    if (node.type !== 'image' || !loading(node.data.pending) || canvasNodeJobs(doc, node.id).length)
      continue
    const meta = generationMeta(node.data.pending)
    if (!meta) continue
    const { params: legacyParams, ...jobMeta } = meta
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
          ...jobMeta,
          clientRequestId: jobId,
          ...(legacyParams ? { params: { ...legacyParams } } : {}),
        },
      },
      generationOrigin,
    )
  }
  for (const job of canvasNodeJobs(doc)) {
    if (!job.meta.nodeGeneration || job.status !== 'loading' || !imageNode(doc, job.nodeId))
      continue
    const meta = job.meta
    const params = (meta.params as TaskParams | undefined) ?? {
      ...useStore.getState().params,
      n: 1,
    }
    if (meta.source === 'builtin-edge' && meta.bffRequestId) {
      if (!claimResume(doc, job.nodeId, meta.bffRequestId)) continue
      void resumeGeneration(
        {
          settings: useStore.getState().settings,
          prompt: meta.prompt,
          params,
          requestId: meta.bffRequestId,
        },
        {
          jobId: job.id,
          nodeId: job.nodeId,
          prompt: meta.prompt,
          params,
          requestId: meta.bffRequestId,
          inputFingerprint: meta.inputFingerprint,
          assetViewLabel: meta.assetViewLabel,
          initialResultId: meta.initialResultId,
          startedAt: job.createdAt,
        },
        nodeGenerationSink(editor, doc, job.nodeId),
      )
      continue
    }
    if (!markUnrecoverable) continue
    const message =
      meta.source === 'builtin-edge'
        ? i18next.t('placeholder.unconfirmed', { ns: 'canvas' })
        : i18next.t('placeholder.byokUnrecoverable', { ns: 'canvas' })
    setCanvasNodeJob(doc, { ...job, status: 'stale', message }, generationOrigin)
  }
}
