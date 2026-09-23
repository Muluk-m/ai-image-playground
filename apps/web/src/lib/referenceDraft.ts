import type { InputImage } from '../types'
import { modelSupportsEdit, NO_EDIT_SUPPORT_MESSAGE } from './channels/profileSelectors'
import { getPublicChannels } from './channels/publicChannels'
import type { ClientProfile } from './channels/types'
import { API_MAX_IMAGES, MAX_INPUT_IMAGES_MESSAGE } from './inputImageLimit'
import { remapImageMentionsForOrder } from './promptImageMentions'

/**
 * 参考图条与提示词的一份值。生成模式的输入框与智能体输入框都是它的实例——
 * 「按 `id` 只加一次、不超上限、模型认参考图、引用跟着序号走」这四条规则只在这里写一遍。
 *
 * 两边各自的参考图还带着自己那几样（素材名、遮罩、是不是跟着画布选区带进来的），
 * 草稿层一概不看，只按 `id` 认图，写回去时原样带着。
 */
export interface ReferenceDraft<R extends InputImage = InputImage> {
  readonly prompt: string
  readonly references: readonly R[]
}

/** 某份草稿里参考图的实际形状；草稿带的别的字段（如智能体的 `mode`）随操作原样留着。 */
type DraftReference<D extends ReferenceDraft> = D['references'][number]

/** 这一刻允许附几张、模型认不认参考图。由调用方给出，草稿自己不认识 profile。 */
export interface ReferenceAdmission {
  readonly limit: number
  readonly supportsEdit: boolean
}

/** 这一组没进去的理由。文案在 `referenceRefusalMessage`，草稿层不碰界面语言。 */
export type ReferenceRefusal = 'overflow' | 'noEdit'

export type AttachResult<D extends ReferenceDraft> =
  | {
      readonly ok: true
      readonly draft: D
      /** 每张入参在新条里的序号，按入参顺序；已在条里的复用原序号。 */
      readonly indexes: readonly number[]
    }
  | { readonly ok: false; readonly reason: ReferenceRefusal }

/**
 * 附一组参考图：整组落地，或者整组不落。一组就是必须一起出现的那几张——素材的全部视角是
 * 一组，右键菜单的一张也是一组；半条素材比没有素材更糟，模型会照着缺了视角的主体出图。
 *
 * 按 `id` 去重：同一张图从画布、素材库还是文件进来都只占条里一位，已在条里的复用原序号，
 * 提示词里的引用因此不用动。整组都已在条里时上限与改图能力都不拦——那一次本来就没往条里加东西。
 */
export function attachReferences<D extends ReferenceDraft>(
  draft: D,
  incoming: readonly DraftReference<D>[],
  admission: ReferenceAdmission,
): AttachResult<D> {
  const references = [...draft.references] as DraftReference<D>[]
  const indexes: number[] = []
  for (const image of incoming) {
    const at = references.findIndex((one) => one.id === image.id)
    if (at >= 0) {
      indexes.push(at)
      continue
    }
    if (!admission.supportsEdit) return { ok: false, reason: 'noEdit' }
    if (references.length >= admission.limit) return { ok: false, reason: 'overflow' }
    references.push(image)
    indexes.push(references.length - 1)
  }
  if (references.length === draft.references.length) return { ok: true, draft, indexes }
  return { ok: true, draft: { ...draft, references }, indexes }
}

/** 整条换掉时的两件可选事：连提示词一起换、把换过的图认作同一位。 */
export interface ReplaceOptions {
  /**
   * 一起换上的提示词。它本来就是按新这条的序号写的（复用一条记录、按模板组装正文），
   * 所以原样收下不再重排——先写条再写提示词那一步，会按旧条把它重排坏。
   */
  readonly prompt?: string
  /** 旧 id → 新 id：同一位上换了一张图（画遮罩时对齐过的那张），指向它的引用跟着走。 */
  readonly equivalentImageIds?: Record<string, string>
}

/**
 * 整条换掉参考图，提示词与条在同一份新值里交出去——「先写条、再写提示词」的顺序陷阱就此消失。
 * 不给新提示词就留着原来那句，引用按新顺序重排，认不到的降级为一段普通文字。
 */
export function replaceReferences<D extends ReferenceDraft>(
  draft: D,
  references: readonly DraftReference<D>[],
  options: ReplaceOptions = {},
): D {
  if (options.prompt !== undefined) return { ...draft, prompt: options.prompt, references }
  return {
    ...draft,
    prompt: remapImageMentionsForOrder(
      draft.prompt,
      [...draft.references],
      [...references],
      options.equivalentImageIds,
    ),
    references,
  }
}

/** 拿掉条里的一张：指向它的引用降级为一段普通文字，其余的跟着新序号走。 */
export function removeReference<D extends ReferenceDraft>(draft: D, index: number): D {
  return replaceReferences(
    draft,
    draft.references.filter((_, at) => at !== index) as DraftReference<D>[],
  )
}

/**
 * 把第 `from` 张挪到第 `to` 位之前（`to` 是落点，可以等于条长即挪到末尾），引用跟着图走。
 * 原地不动就把草稿原样交回去——拖拽落在自己身上是最常见的一次「挪动」。
 */
export function moveReference<D extends ReferenceDraft>(draft: D, from: number, to: number): D {
  const references = [...draft.references] as DraftReference<D>[]
  if (from < 0 || from >= references.length) return draft
  const target = Math.max(0, Math.min(references.length, to))
  const insertAt = from < target ? target - 1 : target
  if (insertAt === from) return draft
  const [moved] = references.splice(from, 1)
  references.splice(insertAt, 0, moved!)
  return replaceReferences(draft, references)
}

/**
 * 某个 profile 下的参考图准入：条的上限，以及那个模型认不认参考图。
 * 每个写入方都从这里取，不再各自读 capability 或写死一个数。传进来的是 profile 而不是
 * 设置，因为「玩同款」要按换上推荐模型之后的能力判，而那一刻设置还没写下去。
 */
export function referenceAdmission(profile: ClientProfile): ReferenceAdmission {
  return {
    limit: API_MAX_IMAGES,
    supportsEdit: modelSupportsEdit(profile, getPublicChannels()),
  }
}

/** 被拒时给用户看的那句话；两条文案都随界面语言变，所以按调用时取。 */
export function referenceRefusalMessage(reason: ReferenceRefusal): string {
  return reason === 'noEdit' ? NO_EDIT_SUPPORT_MESSAGE : MAX_INPUT_IMAGES_MESSAGE
}
