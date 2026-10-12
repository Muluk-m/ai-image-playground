import {
  type CanvasOrigin,
  canvasOrigin,
  type PendingGeneration,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { getImageDimensions } from '../../../lib/canvasImage'
import {
  type GenerationFailure,
  type GenerationReference,
  type GenerationSink,
  type GenerationUnit,
  resumeGeneration,
  startGeneration,
} from '../../../lib/generationJob'
import type { CallApiResult } from '../../../lib/imageApiShared'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { addCompletedCanvasTask, type CanvasProfileSnapshot, useStore } from '../../../store'
import type { TaskParams } from '../../../types'
import type { CanvasEditor } from './editor'
import { fileToDataUrl } from './importImages'

/** 与拖进画布的图同一上限：卡片不要铺得比导入的图还大。 */
const MAX_SIDE = 720
const generationOrigin: CanvasOrigin = canvasOrigin('system', 'node-generation')
const resumedDocs = new WeakSet<Y.Doc>()

interface NodeJobContext {
  prompt: string
  profileView: CanvasProfileSnapshot
}

interface NodeJobHandle {
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

function writePending(doc: Y.Doc, nodeId: string, pending: PendingGeneration): void {
  const node = imageNode(doc, nodeId)
  if (!node) return
  updateCanvasNode(doc, nodeId, { data: { ...node.data, pending } }, generationOrigin)
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
): Promise<boolean> {
  const node = imageNode(doc, nodeId)
  if (!node) return false
  let width = node.width
  let height = node.height
  let naturalWidth: number | undefined
  let naturalHeight: number | undefined
  try {
    const dims = await getImageDimensions(dataUrl)
    naturalWidth = dims.width
    naturalHeight = dims.height
    const scale = Math.min(1, MAX_SIDE / Math.max(dims.width, dims.height, 1))
    width = Math.max(1, Math.round(dims.width * scale))
    height = Math.max(1, Math.round(dims.height * scale))
  } catch {
    // 量不出尺寸就维持卡片现在的大小。
  }
  const patch = {
    width,
    height,
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
        x: node.x,
        y: node.y,
        width,
        height,
        ...(name ? { name } : {}),
        ...(naturalWidth ? { naturalWidth, naturalHeight } : {}),
      },
    ])
  }
  // 空卡第一次落图时，同步会保住原来的几何，这里再把显示尺寸改成图的比例。
  updateCanvasNode(doc, nodeId, { width, height }, generationOrigin)
  return true
}

function nodeGenerationSink(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
): GenerationSink<NodeJobHandle, NodeJobContext> {
  const fail = (id: string, text: string) => {
    const node = imageNode(doc, id)
    const meta = node?.data.pending && 'meta' in node.data.pending ? node.data.pending.meta : {}
    writePending(doc, id, { type: 'placeholder', status: 'error', message: text, meta })
    useStore.getState().showToast(text, 'error')
  }
  return {
    open(unit: GenerationUnit<NodeJobContext>): NodeJobHandle {
      const profile = getActiveApiProfile(useStore.getState().settings)
      writePending(doc, nodeId, {
        type: 'placeholder',
        status: 'loading',
        message: '',
        meta: {
          nodeGeneration: true,
          prompt: unit.context.prompt,
          source: profile.source,
          clientRequestId: unit.clientRequestId,
          params: unit.params,
        },
      })
      return {
        nodeId,
        prompt: unit.context.prompt,
        params: unit.params,
        profileView: unit.context.profileView,
        startedAt: Date.now(),
      }
    },
    accepted(handle: NodeJobHandle, reference: GenerationReference): void {
      if (reference.kind !== 'queue') return
      const node = imageNode(doc, handle.nodeId)
      const pending = node?.data.pending
      if (!node || !pending || pending.type !== 'placeholder') return
      writePending(doc, handle.nodeId, {
        ...pending,
        meta: { ...(pending.meta as object), bffRequestId: reference.requestId },
      })
    },
    progress() {},
    async delivered(handle: NodeJobHandle, result: CallApiResult) {
      const dataUrl = result.images[0]
      if (!dataUrl) {
        fail(handle.nodeId, i18next.t('placeholder.failed', { ns: 'canvas' }))
        return
      }
      const placed = await putBitmapOnNode(editor, doc, handle.nodeId, dataUrl)
      if (!placed) return
      void addCompletedCanvasTask({
        prompt: handle.prompt,
        params: handle.params,
        images: [dataUrl],
        ...(handle.startedAt ? { elapsed: Date.now() - handle.startedAt } : {}),
        ...(handle.profileView ? { profile: handle.profileView } : {}),
      })
    },
    failed(handle: NodeJobHandle, failure: GenerationFailure) {
      fail(handle.nodeId, failure.text)
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
  const settings = useStore.getState().settings
  const profile = getActiveApiProfile(settings)
  const view = clientProfileToApiProfile(profile)
  const params = { ...useStore.getState().params, n: 1 }
  const handles = startGeneration<NodeJobHandle, NodeJobContext>(
    {
      settings,
      profile,
      params,
      variants: [
        {
          prompt,
          inputImageDataUrls,
          context: {
            prompt,
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
export function resumeNodeGenerations(editor: CanvasEditor, doc: Y.Doc): void {
  if (resumedDocs.has(doc)) return
  resumedDocs.add(doc)
  for (const node of readCanvasDocument(doc).nodes) {
    if (node.type !== 'image' || !loading(node.data.pending)) continue
    const meta = generationMeta(node.data.pending)
    if (!meta) continue
    const params = meta.params ?? { ...useStore.getState().params, n: 1 }
    if (meta.source === 'builtin-edge' && meta.bffRequestId) {
      void resumeGeneration(
        {
          settings: useStore.getState().settings,
          prompt: meta.prompt,
          params,
          requestId: meta.bffRequestId,
        },
        { nodeId: node.id, prompt: meta.prompt, params },
        nodeGenerationSink(editor, doc, node.id),
      )
      continue
    }
    const message =
      meta.source === 'builtin-edge'
        ? i18next.t('placeholder.unconfirmed', { ns: 'canvas' })
        : i18next.t('placeholder.byokUnrecoverable', { ns: 'canvas' })
    writePending(doc, node.id, {
      type: 'placeholder',
      status: 'stale',
      message,
      meta: node.data.pending && 'meta' in node.data.pending ? node.data.pending.meta : {},
    })
  }
}
