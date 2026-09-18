import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import {
  createMentionLabels,
  insertImageMentionAtVisibleRange,
  type MentionLabelResolver,
  remapImageMentionsForOrder,
  replaceImageMentionsForApi,
} from '../../../lib/promptImageMentions'
import type { InputImage } from '../../../types'

/** 输入框附上的一张参考图。`id` 是画布对象 id 或素材的图片 id，模型据此指认要改哪一张。 */
export interface AgentReference extends InputImage {
  /** 素材名；有名字时胶囊显示名字而不是序号。 */
  readonly name?: string
  readonly maskDataUrl?: string
  /**
   * `'selection'` 即跟着画布选区自动带进来的，缺席即用户手动附上的。随草稿落盘：输入框重挂、
   * 发送失败放回来都还认得出。老草稿里没有这一项，读回来按手动算。
   */
  readonly origin?: 'selection'
}

export interface AgentDraft {
  readonly prompt: string
  readonly references: readonly AgentReference[]
  /** 这份草稿发出去时要创作什么。老草稿里没有这一项，读回来按图片算。 */
  readonly mode?: AgentMode
}

export const EMPTY_DRAFT: AgentDraft = { prompt: '', references: [] }

export function draftMode(draft: AgentDraft): AgentMode {
  return draft.mode === 'video' ? 'video' : 'image'
}

export function referenceLabels(references: readonly AgentReference[]): MentionLabelResolver {
  const named: Record<string, string> = {}
  for (const reference of references) {
    if (reference.name) named[reference.id] = reference.name
  }
  return createMentionLabels([...references], named)
}

export interface AttachedReference {
  readonly draft: AgentDraft
  /** 可见文本坐标系里的光标落点。 */
  readonly cursor: number
}

/**
 * 在可见文本的 `[start, cursor)` 上插一条引用。同一张图按 `id` 复用原序号，
 * 不重复附加——画布对象与素材走的是同一条路。
 */
export function attachReference(
  draft: AgentDraft,
  reference: AgentReference,
  start: number,
  cursor: number,
): AttachedReference {
  const at = draft.references.findIndex((one) => one.id === reference.id)
  const references = at >= 0 ? draft.references : [...draft.references, reference]
  const index = at >= 0 ? at : references.length - 1
  const inserted = insertImageMentionAtVisibleRange(
    draft.prompt,
    start,
    cursor,
    index,
    referenceLabels(draft.references),
    referenceLabels(references),
  )
  return { draft: { prompt: inserted.prompt, references }, cursor: inserted.cursor }
}

/** 拿掉一张参考图，指向它的引用降级为「已移除」，其余的跟着新序号走。 */
export function removeReference(draft: AgentDraft, index: number): AgentDraft {
  const references = draft.references.filter((_, at) => at !== index)
  return {
    prompt: remapImageMentionsForOrder(draft.prompt, [...draft.references], [...references]),
    references,
  }
}

/**
 * 换掉一张参考图上的遮罩。按 `id` 认领而不是下标：编辑器开着的时候用户可能又加又删，
 * 回来时下标早就不是原来那个了。图一并换成编辑器交回来的那张——为对齐遮罩它可能改过尺寸。
 * 认不到就原样返回，宁可这次白画也不能写到别人身上。
 */
export function setReferenceMask(
  draft: AgentDraft,
  id: string,
  mask: { readonly maskDataUrl: string; readonly dataUrl: string },
): AgentDraft {
  return mapReference(draft, id, (reference) => ({
    ...reference,
    dataUrl: mask.dataUrl,
    maskDataUrl: mask.maskDataUrl,
  }))
}

/** 去掉遮罩，参考图本身留着——图仍是编辑器那张，尺寸换回去反而对不上后续重画。 */
export function clearReferenceMask(draft: AgentDraft, id: string): AgentDraft {
  return mapReference(draft, id, ({ maskDataUrl: _dropped, ...rest }) => rest)
}

function mapReference(
  draft: AgentDraft,
  id: string,
  transform: (reference: AgentReference) => AgentReference,
): AgentDraft {
  const at = draft.references.findIndex((one) => one.id === id)
  if (at < 0) return draft
  return {
    ...draft,
    references: draft.references.map((one, index) => (index === at ? transform(one) : one)),
  }
}

export interface AgentSubmission {
  readonly text: string
  readonly references: readonly AgentTurnReference[]
}

/** 发送形状：胶囊按序号转成 `[image N]`，参考图按同一个序号排。 */
export function draftForSubmit(draft: AgentDraft): AgentSubmission {
  return {
    text: replaceImageMentionsForApi(draft.prompt, draft.references.length).trim(),
    references: draft.references.map((reference) => ({
      imageId: reference.id,
      dataUrl: reference.dataUrl,
      ...(reference.name ? { name: reference.name } : {}),
      ...(reference.maskDataUrl ? { maskDataUrl: reference.maskDataUrl } : {}),
    })),
  }
}
