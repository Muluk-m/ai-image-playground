import type { InputImage } from '../types'
import {
  getPromptAssetSlots,
  type PromptAssetSlot,
  setPromptAssetSlotImages,
} from './promptImageMentions'
import {
  type AttachResult,
  attachReferences,
  type ReferenceAdmission,
  type ReferenceDraft,
} from './referenceDraft'

/**
 * 素材位的填与清（CONTEXT「素材位」）。两个输入框共用：填进去的图走参考图草稿的附图规则
 * （按 `id` 去重、整组落地或不落），位里装的就是指向它们的引用。
 */

type DraftReference<D extends ReferenceDraft> = D['references'][number]

/** 输入框按下标找位；中途提示词变过、那一位已经换了人时，不能把图塞给别的位。 */
export function assetSlotAt(
  prompt: string,
  occurrence: number,
  key: string,
): PromptAssetSlot | undefined {
  const slot = getPromptAssetSlots(prompt)[occurrence]
  return slot?.key === key ? slot : undefined
}

/**
 * 把一组图放进第 `occurrence` 个素材位。位不能放多图时只取第一张；原来装着的图被换掉。
 * 放不下就整组不放，理由与附图一致。换下来的图与删掉一个 `@` 胶囊一样留在参考图条里，
 * 条里的图是谁附的草稿不记，所以不替用户拿掉。
 */
export function fillAssetSlot<D extends ReferenceDraft>(
  draft: D,
  occurrence: number,
  images: readonly DraftReference<D>[],
  admission: ReferenceAdmission<DraftReference<D>>,
): AttachResult<D> {
  const slot = getPromptAssetSlots(draft.prompt)[occurrence]
  if (!slot || images.length === 0) return { ok: true, draft, indexes: [] }
  const incoming = slot.multiple ? images : images.slice(0, 1)
  const attached = attachReferences(draft, incoming, admission)
  if (!attached.ok) return attached
  const indexes = [...new Set(attached.indexes)]
  const prompt = setPromptAssetSlotImages(attached.draft.prompt, occurrence, indexes)
  return { ok: true, draft: { ...attached.draft, prompt }, indexes }
}

/** 把第 `occurrence` 个素材位变回空位；图留在参考图条里（见 `fillAssetSlot`）。 */
export function clearAssetSlot<D extends ReferenceDraft>(draft: D, occurrence: number): D {
  const slot = getPromptAssetSlots(draft.prompt)[occurrence]
  if (!slot || slot.imageIndexes.length === 0) return draft
  return { ...draft, prompt: setPromptAssetSlotImages(draft.prompt, occurrence, []) }
}

/** 填好的位里那几张图，按位里的顺序。 */
export function assetSlotImages<R extends InputImage>(
  slot: PromptAssetSlot,
  references: readonly R[],
): R[] {
  return slot.imageIndexes.flatMap((index) => {
    const reference = references[index]
    return reference ? [reference] : []
  })
}
