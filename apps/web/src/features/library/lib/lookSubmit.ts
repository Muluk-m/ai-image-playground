import { assembleLookRequest, pickLookAssetImageId } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { getImageDimensions } from '../../../lib/canvasImage'
import { remapImageMentionsForOrder } from '../../../lib/promptImageMentions'
import { referenceAdmission, referenceRefusalMessage } from '../../../lib/referenceDraft'
import {
  ensureImageCached,
  isModelAvailableForProfile,
  storeImageFromFile,
  submitPrepared,
  useStore,
} from '../../../store'
import { lookImageUrl } from '../components/LookImage'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { useActiveLook } from './activeLook'
import { beginLookSubmission } from './lookSubmissionOperation'
import type { LookItem } from './looks'

export { cancelLookSubmission, useLookSubmission } from './lookSubmissionOperation'

/** 参考图条里出现过的素材：按首次出现的顺序，一条素材只算一次。 */
export function assetsForInputImages(
  inputImages: ReadonlyArray<{ id: string }>,
  assets: readonly AssetRecord[],
): AssetRecord[] {
  const picked: AssetRecord[] = []
  for (const image of inputImages) {
    const asset = assets.find((one) => one.views.some((view) => view.imageId === image.id))
    if (asset && !picked.includes(asset)) picked.push(asset)
  }
  return picked
}

export type LookSubmissionCheck =
  | { readonly ok: true; readonly assets: AssetRecord[] }
  | { readonly ok: false; readonly reason: 'slot_mismatch'; readonly expected: number }

/** 提交前的判定：附了几条素材、模板要几条。不够或多了都不发。 */
export function checkLookSubmission(
  look: LookItem,
  inputImages: ReadonlyArray<{ id: string }>,
  assets: readonly AssetRecord[],
): LookSubmissionCheck {
  const picked = assetsForInputImages(inputImages, assets)
  if (picked.length !== look.slotCount) {
    return { ok: false, reason: 'slot_mismatch', expected: look.slotCount }
  }
  return { ok: true, assets: picked }
}

/** 加载失败的那张图，按用户认得的名字报：素材名或模板名；都没有就不报名字。 */
class LookImageError extends Error {
  constructor(readonly source: { asset?: string; look?: string }) {
    super('look image unavailable')
  }
}

const PREPARE_CONCURRENCY = 4

/** 保序并发：结果顺序与输入一致，同时最多跑 `limit` 个。 */
async function mapInOrder<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 预置模板的参考图在 BFF 上：先搬进本机 image store 才能当参考图提交。 */
function referenceImageIds(look: LookItem, signal: AbortSignal): Promise<string[]> {
  return mapInOrder(look.references, PREPARE_CONCURRENCY, async (ref) => {
    if (ref.kind === 'image') return ref.imageId
    try {
      const response = await fetch(lookImageUrl(ref.url), { signal })
      if (!response.ok) throw new Error(ref.url)
      const blob = await response.blob()
      if (!blob.type.startsWith('image/') || blob.size === 0) throw new Error(ref.url)
      const file = new File([blob], ref.url.split('/').pop() ?? 'reference', { type: blob.type })
      return (await storeImageFromFile(file)).id
    } catch (error) {
      if (signal.aborted) throw error
      throw new LookImageError({ look: look.name })
    }
  })
}

function imageUnavailableMessage(source: { asset?: string; look?: string }): string {
  if (source.asset)
    return i18next.t('look.inputsUnavailable', { ns: 'library', image: source.asset })
  if (source.look)
    return i18next.t('look.referenceUnavailable', { ns: 'library', name: source.look })
  return i18next.t('look.inputUnavailable', { ns: 'library' })
}

/**
 * 生成模式下带着模板胶囊发送：按模板正文与素材组装提示词和参考图顺序，走普通提交。
 * 用户在输入框里打的字接在正文后面；发完把输入框还原成他打的那几个字。
 */
export async function submitWithLook(look: LookItem, body: string): Promise<boolean> {
  const store = useStore.getState()
  const check = checkLookSubmission(look, store.inputImages, useLibraryStore.getState().assets)
  if (!check.ok) return false
  const profile = getActiveApiProfile(store.settings)
  const admission = referenceAdmission({ ...profile, selectedModelId: look.model })
  // 下载参考图之前就判：模型不可用时别白搬一趟图。
  if (!isModelAvailableForProfile(store.settings, profile, look.model)) {
    store.showToast(i18next.t('submit.modelUnavailable', { ns: 'store' }), 'error')
    return false
  }
  if (!admission.acceptsReferences) {
    store.showToast(referenceRefusalMessage('noEdit'), 'error')
    return false
  }
  // zustand 状态整体替换、不原地改：留住这一刻的引用就是冻结。
  const { prompt, inputImages, params, slotValues, maskDraft } = store
  const assets = check.assets
  const assetNameOf = (imageId: string) =>
    assets.find((asset) => asset.views.some((view) => view.imageId === imageId))?.name
  const operation = beginLookSubmission()
  if (!operation) return false
  try {
    const assembled = assembleLookRequest({
      look: {
        body,
        slotCount: look.slotCount,
        referenceImageIds: await operation.wait(referenceImageIds(look, operation.signal)),
      },
      maxInputs: admission.limit,
      firstImageId: maskDraft?.targetImageId,
      assets: assets.map((asset) => ({ id: asset.id, name: asset.name, views: asset.views })),
    })
    if (!assembled.ok) {
      store.showToast(
        assembled.reason === 'input_limit_exceeded'
          ? i18next.t(look.origin === 'user' ? 'look.inputLimitOwn' : 'look.inputLimit', {
              ns: 'library',
              count: assembled.required,
              max: assembled.limit,
            })
          : imageUnavailableMessage({
              asset: assets.find((asset) => asset.id === assembled.assetId)?.name,
            }),
        'error',
      )
      return false
    }

    const images = await operation.wait(
      mapInOrder(assembled.inputImageIds, PREPARE_CONCURRENCY, async (id) => {
        const source = { asset: assetNameOf(id), look: look.name }
        const dataUrl = await ensureImageCached(id).catch(() => undefined)
        if (!dataUrl) throw new LookImageError(source)
        const dimensions = await getImageDimensions(dataUrl).catch(() => null)
        if (!dimensions?.width || !dimensions.height) throw new LookImageError(source)
        return { id, dataUrl }
      }),
    )
    const equivalentImageIds: Record<string, string> = {}
    for (const asset of assets) {
      const selected = pickLookAssetImageId(asset, maskDraft?.targetImageId)
      if (selected) for (const view of asset.views) equivalentImageIds[view.imageId] = selected
    }
    const typed = remapImageMentionsForOrder(prompt, inputImages, images, equivalentImageIds)
    const ids = await operation.wait(
      submitPrepared(
        {
          prompt: typed.trim() ? `${assembled.prompt}\n\n${typed.trim()}` : assembled.prompt,
          inputImages: images,
          params: { ...params, size: look.size },
          slotValues,
          maskDraft,
          profileId: profile.id,
          profile,
          modelId: look.model,
        },
        {
          signal: operation.signal,
          isCurrent: operation.isCurrent,
          pendingId: operation.id,
          sourcePath: operation.sourcePath,
          ownerScope: operation.ownerScope,
          onLoginQueued: operation.markPending,
          onConfirmationPending: operation.setConfirmationPending,
          template: true,
        },
      ),
    )
    if (!ids.length) return false
    if (!operation.isEdited()) {
      if (store.settings.clearInputAfterSubmit) {
        store.setPrompt('')
        store.clearInputImages()
      }
      useActiveLook.getState().set(null)
    }
    if (look.record) void useLibraryStore.getState().noteLookUsed(look.record.id)
    return true
  } catch (error) {
    const reason = operation.signal.aborted ? operation.signal.reason : undefined
    if (reason && reason.name !== 'TimeoutError') return false
    store.showToast(
      reason
        ? i18next.t('look.prepareTimeout', { ns: 'library' })
        : error instanceof LookImageError
          ? imageUnavailableMessage(error.source)
          : i18next.t('look.prepareFailed', { ns: 'library' }),
      'error',
    )
    return false
  } finally {
    operation.finish()
  }
}
