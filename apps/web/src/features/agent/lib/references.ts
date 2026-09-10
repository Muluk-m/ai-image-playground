import type { AgentTurnReference } from '@image-playground/shared'
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
}

export interface AgentDraft {
  readonly prompt: string
  readonly references: readonly AgentReference[]
}

export const EMPTY_DRAFT: AgentDraft = { prompt: '', references: [] }

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
