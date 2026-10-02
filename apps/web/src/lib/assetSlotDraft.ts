import type { InputImage } from '../types'
import {
  getMentionedImageIndexes,
  getPromptAssetSlots,
  type PromptAssetSlot,
  setPromptAssetSlotImages,
} from './promptImageMentions'
import {
  type AttachResult,
  attachReferences,
  type ReferenceAdmission,
  type ReferenceDraft,
  replaceReferences,
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
 * 只为这一位附进来的图，位不再装着它、提示词里也没有别的引用指向它时一并拿掉：上传图只是这一轮
 * 的参考图，位清空了它就没有留在条里的理由。条里原本就有、或者别处还 `@` 着的图留着。
 */
function dropOrphans<D extends ReferenceDraft>(
  before: D,
  after: D,
  previous: readonly number[],
): D {
  const mentioned = new Set(getMentionedImageIndexes(after.prompt))
  const candidates = new Set(
    previous.flatMap((index) => {
      const id = before.references[index]?.id
      return id ? [id] : []
    }),
  )
  const references = after.references.filter(
    (reference, index) => !candidates.has(reference.id) || mentioned.has(index),
  ) as DraftReference<D>[]
  return references.length === after.references.length
    ? after
    : replaceReferences(after, references)
}

/**
 * 把一组图放进第 `occurrence` 个素材位。位不能放多图时只取第一张；原来装着的图被换掉。
 * 放不下就整组不放，理由与附图一致。
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
  const filled = {
    ...attached.draft,
    prompt: setPromptAssetSlotImages(attached.draft.prompt, occurrence, indexes),
  }
  const replaced = slot.imageIndexes.filter((index) => !indexes.includes(index))
  return { ok: true, draft: dropOrphans(attached.draft, filled, replaced), indexes }
}

/** 把第 `occurrence` 个素材位变回空位。 */
export function clearAssetSlot<D extends ReferenceDraft>(draft: D, occurrence: number): D {
  const slot = getPromptAssetSlots(draft.prompt)[occurrence]
  if (!slot || slot.imageIndexes.length === 0) return draft
  const cleared = { ...draft, prompt: setPromptAssetSlotImages(draft.prompt, occurrence, []) }
  return dropOrphans(draft, cleared, slot.imageIndexes)
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
