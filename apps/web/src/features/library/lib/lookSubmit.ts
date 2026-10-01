import { assembleLookRequest, pickLookAssetImageId } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { getImageDimensions } from '../../../lib/canvasImage'
import { remapImageMentionsForOrder } from '../../../lib/promptImageMentions'
import { beginLookSubmission } from './lookSubmissionOperation'

export { cancelLookSubmission, useLookSubmission } from './lookSubmissionOperation'

import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { getProfileModels } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { referenceAdmission, referenceRefusalMessage } from '../../../lib/referenceDraft'
import { ensureImageCached, storeImageFromFile, submitPrepared, useStore } from '../../../store'
import { lookImageUrl } from '../components/LookImage'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { useActiveLook } from './activeLook'
import type { LookItem } from './looks'

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

/** 预置模板的参考图在 BFF 上：先搬进本机 image store 才能当参考图提交。 */
async function referenceImageIds(
  look: LookItem,
  signal: AbortSignal,
  onImage: (name: string) => void,
): Promise<string[]> {
  const ids: string[] = []
  for (const ref of look.references) {
    onImage(ref.kind === 'image' ? ref.imageId : (ref.url.split('/').pop() ?? look.name))
    if (ref.kind === 'image') {
      ids.push(ref.imageId)
      continue
    }
    const response = await fetch(lookImageUrl(ref.url), { signal })
    if (!response.ok) throw new Error(ref.url)
    const blob = await response.blob()
    if (!blob.type.startsWith('image/') || blob.size === 0) throw new Error(ref.url)
    const file = new File([blob], ref.url.split('/').pop() ?? 'reference', { type: blob.type })
    ids.push((await storeImageFromFile(file)).id)
  }
  return ids
}

/**
 * 生成模式下带着模板胶囊发送：按模板正文与素材组装提示词和参考图顺序，走普通提交。
 * 用户在输入框里打的字接在正文后面；发完把输入框还原成他打的那几个字。
 */
export async function submitWithLook(look: LookItem, body: string): Promise<boolean> {
  const store = useStore.getState()
  const check = checkLookSubmission(look, store.inputImages, useLibraryStore.getState().assets)
  if (!check.ok) return false
  const admission = referenceAdmission({
    ...getActiveApiProfile(store.settings),
    selectedModelId: look.model,
  })
  if (
    !getProfileModels(getActiveApiProfile(store.settings), getPublicChannels()).includes(look.model)
  ) {
    store.showToast(i18next.t('submit.modelUnavailable', { ns: 'store' }), 'error')
    return false
  }
  if (!admission.acceptsReferences) {
    store.showToast(referenceRefusalMessage('noEdit'), 'error')
    return false
  }
  const frozen = structuredClone({
    look,
    body,
    assets: check.assets,
    prompt: store.prompt,
    inputImages: store.inputImages,
    params: store.params,
    slotValues: store.slotValues,
    maskDraft: store.maskDraft,
    profile: getActiveApiProfile(store.settings),
  })
  const operation = beginLookSubmission()
  if (!operation) return false
  let preparingImage = look.name
  try {
    const assembled = assembleLookRequest({
      look: {
        body: frozen.body,
        slotCount: frozen.look.slotCount,
        referenceImageIds: await operation.wait(
          referenceImageIds(frozen.look, operation.signal, (name) => {
            preparingImage = name
          }),
        ),
      },
      maxInputs: admission.limit,
      firstImageId: frozen.maskDraft?.targetImageId,
      assets: frozen.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        views: asset.views,
      })),
    })
    if (!assembled.ok) {
      store.showToast(
        assembled.reason === 'input_limit_exceeded'
          ? i18next.t('look.inputLimit', {
              ns: 'library',
              count: assembled.required,
              max: assembled.limit,
            })
          : i18next.t('look.inputsUnavailable', {
              ns: 'library',
              image: assembled.assetId ?? look.name,
            }),
        'error',
      )
      return false
    }

    const images = []
    for (const id of assembled.inputImageIds) {
      preparingImage =
        frozen.assets.find((asset) => asset.views.some((view) => view.imageId === id))?.name ?? id
      const dataUrl = await operation.wait(ensureImageCached(id))
      if (!dataUrl) throw new Error(id)
      const dimensions = await operation.wait(getImageDimensions(dataUrl))
      if (!dimensions.width || !dimensions.height) throw new Error(id)
      images.push({ id, dataUrl })
    }
    const equivalentImageIds: Record<string, string> = {}
    for (const asset of frozen.assets) {
      const selected = pickLookAssetImageId(asset, frozen.maskDraft?.targetImageId)
      if (selected) for (const view of asset.views) equivalentImageIds[view.imageId] = selected
    }
    const typed = remapImageMentionsForOrder(
      frozen.prompt,
      frozen.inputImages,
      images,
      equivalentImageIds,
    )
    const ids = await operation.wait(
      submitPrepared(
        {
          prompt: typed.trim() ? `${assembled.prompt}\n\n${typed.trim()}` : assembled.prompt,
          inputImages: images,
          params: { ...frozen.params, size: frozen.look.size },
          slotValues: frozen.slotValues,
          maskDraft: frozen.maskDraft,
          profileId: frozen.profile.id,
          profile: frozen.profile,
          modelId: frozen.look.model,
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
  } catch {
    if (operation.signal.aborted && operation.signal.reason?.name !== 'TimeoutError') return false
    store.showToast(
      i18next.t('look.inputsUnavailable', { ns: 'library', image: preparingImage }),
      'error',
    )
    return false
  } finally {
    operation.finish()
  }
}
