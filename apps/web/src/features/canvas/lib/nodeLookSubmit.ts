import { assembleLookRequest } from '@image-playground/shared'
import type * as Y from 'yjs'
import { i18next } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { getImageDimensions } from '../../../lib/canvasImage'
import { referenceAdmission, referenceRefusalMessage } from '../../../lib/referenceDraft'
import {
  ensureImageCached,
  isModelAvailableForProfile,
  storeImageFromFile,
  useStore,
} from '../../../store'
import { lookImageUrl } from '../../library/components/LookImage'
import { pinLookParams, useActiveLook } from '../../library/lib/activeLook'
import { checkLookSubmission } from '../../library/lib/lookSubmit'
import type { LookItem } from '../../library/lib/looks'
import { useLibraryStore } from '../../library/store'
import type { CanvasEditor } from './editor'
import type { NodeReference } from './nodeCanvasFlow'
import { submitNodeImage } from './nodeCanvasGenerate'

const preparing = new Set<string>()

/** 节点上的参考图按文件身份去对素材。临时上传不占素材位。 */
function referenceImages(references: readonly NodeReference[]): { id: string }[] {
  return references.flatMap((reference) => (reference.fileId ? [{ id: reference.fileId }] : []))
}

async function loadReferenceIds(look: LookItem): Promise<string[]> {
  const ids: string[] = []
  for (const reference of look.references) {
    if (reference.kind === 'image') {
      ids.push(reference.imageId)
      continue
    }
    const response = await fetch(lookImageUrl(reference.url))
    if (!response.ok) throw new Error(look.name)
    const blob = await response.blob()
    if (!blob.type.startsWith('image/') || blob.size === 0) throw new Error(look.name)
    const file = new File([blob], reference.url.split('/').pop() ?? 'reference', {
      type: blob.type,
    })
    ids.push((await storeImageFromFile(file)).id)
  }
  return ids
}

async function imageDataUrl(
  id: string,
  files: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const local = files[id]
  if (local) return local
  const cached = await ensureImageCached(id).catch(() => undefined)
  if (!cached) return undefined
  const dimensions = await getImageDimensions(cached).catch(() => null)
  return dimensions?.width && dimensions.height ? cached : undefined
}

interface PreparedNodeLook {
  prompt: string
  inputImageDataUrls: string[]
  configuration: {
    settings: ReturnType<typeof useStore.getState>['settings']
    params: ReturnType<typeof useStore.getState>['params']
  }
}

/**
 * 组装模板请求。素材、模型或图片没准备好就停住，调用方此时还不能新建节点。
 */
async function prepareNodeLook(
  look: LookItem,
  typed: string,
  references: readonly NodeReference[],
  files: Readonly<Record<string, string>>,
): Promise<PreparedNodeLook | null> {
  try {
    return await assembleNodeLook(look, typed, references, files)
  } catch {
    useStore.getState().showToast(i18next.t('look.prepareFailed', { ns: 'library' }), 'error')
    return null
  }
}

async function assembleNodeLook(
  look: LookItem,
  typed: string,
  references: readonly NodeReference[],
  files: Readonly<Record<string, string>>,
): Promise<PreparedNodeLook | null> {
  const store = useStore.getState()
  const check = checkLookSubmission(
    look,
    referenceImages(references),
    useLibraryStore.getState().assets,
  )
  if (!check.ok) return null
  const profile = getActiveApiProfile(store.settings)
  const admission = referenceAdmission({ ...profile, selectedModelId: look.model })
  if (!isModelAvailableForProfile(store.settings, profile, look.model)) {
    store.showToast(i18next.t('submit.modelUnavailable', { ns: 'store' }), 'error')
    return null
  }
  if (!admission.acceptsReferences) {
    store.showToast(referenceRefusalMessage('noEdit'), 'error')
    return null
  }
  const assembled = assembleLookRequest({
    look: {
      body: look.record?.body ?? look.skill?.template?.body ?? '',
      slotCount: look.slotCount,
      referenceImageIds: await loadReferenceIds(look),
    },
    maxInputs: admission.limit,
    assets: check.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      views: asset.views,
    })),
  })
  if (!assembled.ok) {
    store.showToast(
      assembled.reason === 'input_limit_exceeded'
        ? i18next.t(look.origin === 'user' ? 'look.inputLimitOwn' : 'look.inputLimit', {
            ns: 'library',
            count: assembled.required,
            max: assembled.limit,
          })
        : i18next.t('look.inputsUnavailable', {
            ns: 'library',
            image: check.assets.find((asset) => asset.id === assembled.assetId)?.name ?? look.name,
          }),
      'error',
    )
    return null
  }
  const inputImageDataUrls: string[] = []
  for (const id of assembled.inputImageIds) {
    const url = await imageDataUrl(id, files)
    if (!url) {
      const asset = check.assets.find((one) => one.views.some((view) => view.imageId === id))
      store.showToast(
        i18next.t(asset ? 'look.inputsUnavailable' : 'look.referenceUnavailable', {
          ns: 'library',
          image: asset?.name,
          name: look.name,
        }),
        'error',
      )
      return null
    }
    inputImageDataUrls.push(url)
  }
  const typedText = typed.trim()
  pinLookParams(look)
  const next = useStore.getState()
  return {
    prompt: typedText ? `${assembled.prompt}\n\n${typedText}` : assembled.prompt,
    inputImageDataUrls,
    configuration: { settings: next.settings, params: { ...next.params, size: look.size } },
  }
}

function finishLook(look: LookItem): void {
  if (useActiveLook.getState().look?.skillName === look.skillName)
    useActiveLook.getState().set(null)
  if (look.record)
    void useLibraryStore
      .getState()
      .noteLookUsed(look.record.id)
      .catch(() => {})
}

/** 把已经组装好的模板请求写进这张图片节点。 */
function commitNodeLook(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
  look: LookItem,
  prepared: PreparedNodeLook,
): boolean {
  const accepted = submitNodeImage(
    editor,
    doc,
    nodeId,
    prepared.prompt,
    prepared.inputImageDataUrls,
    undefined,
    undefined,
    prepared.configuration,
  )
  if (accepted) finishLook(look)
  return accepted
}

/** 往已经存在的图片节点提交一份准备好的模板请求。 */
export async function submitNodeWithLook(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
  look: LookItem,
  typed: string,
  references: readonly NodeReference[],
  files: Readonly<Record<string, string>>,
): Promise<boolean> {
  if (preparing.has(nodeId)) return false
  preparing.add(nodeId)
  try {
    const prepared = await prepareNodeLook(look, typed, references, files)
    if (!prepared) return false
    return commitNodeLook(editor, doc, nodeId, look, prepared)
  } finally {
    preparing.delete(nodeId)
  }
}
