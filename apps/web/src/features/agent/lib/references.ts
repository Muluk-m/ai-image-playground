import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_TURN_MAX_REFERENCES,
  type AgentInlineReference,
  type AgentMode,
} from '@image-playground/shared'
import { mediaIdentity } from '../../../lib/cloudMedia'
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
  /**
   * 这份草稿上次停在什么创作类型。轮的类型现在由项目的画布类型定，这里只剩存储里的历史值，
   * 草稿层自己原样保管（`withMode`），没有人再据它决定发什么。
   */
  readonly mode?: AgentMode
}

export const EMPTY_DRAFT: AgentDraft = { prompt: '', references: [] }

/** 草稿里有没有用户自己写下或附上的东西；跟着画布选区自动带进来的图不算。 */
export function hasDraftContent(draft: AgentDraft): boolean {
  return draft.prompt.trim() !== '' || draft.references.some((one) => one.origin !== 'selection')
}

/**
 * 每张参考图在胶囊与 @ 引用里显示的名字。同名的（连传三张都叫 image 的文件很常见）
 * 按出现顺序编号成「image 1 / image 2」，否则用户分不清正文里的 @image 指哪一张。
 * 没名字的不在这里管，仍走序号标签。
 */
export function referenceDisplayNames(
  references: readonly { readonly name?: string }[],
): (string | undefined)[] {
  const total: Record<string, number> = {}
  for (const reference of references) {
    if (reference.name) total[reference.name] = (total[reference.name] ?? 0) + 1
  }
  const seen: Record<string, number> = {}
  return references.map((reference) => {
    if (!reference.name) return undefined
    if ((total[reference.name] ?? 0) < 2) return reference.name
    seen[reference.name] = (seen[reference.name] ?? 0) + 1
    return `${reference.name} ${seen[reference.name]}`
  })
}

export function referenceLabels(references: readonly AgentReference[]): MentionLabelResolver {
  const named: Record<string, string> = {}
  const names = referenceDisplayNames(references)
  references.forEach((reference, index) => {
    const name = names[index]
    if (name) named[reference.id] = name
  })
  return createMentionLabels([...references], named)
}

/**
 * 这张参考图发送时能不能按 id 走——判据与发送前 `withCloudMedia` 能换成 id 的条件一致：
 * 没画遮罩，并且它本来就是云媒体（`aip-media:`），或者是云项目画布上某张图的原件。
 * 批注合成图、拖进来的文件、素材都不在其列，只能内联字节。
 */
export interface ReferenceTransport {
  /** 当前是不是云项目：本机项目的画布图没有云端那份，只能内联。 */
  readonly cloud: boolean
  /** 画布上各张图此刻的来源；不是原件（例如烧了批注）的认不出。 */
  readonly canvasSources: ReadonlySet<string>
}

/** 什么都认不出的时候：一律按内联算。 */
export const INLINE_ONLY: ReferenceTransport = { cloud: false, canvasSources: new Set() }

export function sendsById(reference: AgentReference, transport: ReferenceTransport): boolean {
  if (reference.maskDataUrl) return false
  if (mediaIdentity(reference.dataUrl)) return true
  return transport.cloud && transport.canvasSources.has(reference.dataUrl)
}

/**
 * 草稿里还放不放得下这一张。两道上限：一轮总张数（按 id 的不进请求体，可以很多），
 * 以及只能内联字节的那几张——服务端对这两个数都是硬校验，超了整轮以 4xx 打回。
 */
export function hasRoomFor(
  references: readonly AgentReference[],
  reference: AgentReference,
  transport: ReferenceTransport,
): boolean {
  if (references.length >= AGENT_TURN_MAX_REFERENCES) return false
  if (sendsById(reference, transport)) return true
  const inline = references.filter((one) => !sendsById(one, transport)).length
  return inline < AGENT_TURN_MAX_INLINE_REFERENCES
}

export interface AttachedReference {
  readonly draft: AgentDraft
  /** 可见文本坐标系里的光标落点。 */
  readonly cursor: number
  /** 这一张没放进去：本轮的参考图已经满了。草稿与光标原样返回。 */
  readonly overflow: boolean
}

/**
 * 在可见文本的 `[start, cursor)` 上插一条引用。同一张图按 `id` 复用原序号，
 * 不重复附加——画布对象与素材走的是同一条路。
 *
 * 满了就不附（见 `hasRoomFor`）：超出去的那一份会让整轮起轮被打回，用户的话连同图一起白等。
 */
export function attachReference(
  draft: AgentDraft,
  reference: AgentReference,
  start: number,
  cursor: number,
  transport: ReferenceTransport = INLINE_ONLY,
): AttachedReference {
  const at = draft.references.findIndex((one) => one.id === reference.id)
  if (at < 0 && !hasRoomFor(draft.references, reference, transport))
    return { draft, cursor, overflow: true }
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
  return {
    draft: { prompt: inserted.prompt, references },
    cursor: inserted.cursor,
    overflow: false,
  }
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
 * 一次拿掉所有跟着画布选区带进来的参考图。指向它们的引用降级为「已移除」，手动附上的跟着新序号走。
 * 选区模块会把仍选着、草稿里却没了的认成用户拒绝过，不会立刻再塞回来。
 */
export function removeSelectionReferences(draft: AgentDraft): AgentDraft {
  const references = draft.references.filter((one) => one.origin !== 'selection')
  if (references.length === draft.references.length) return draft
  return {
    ...draft,
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
  /**
   * 输入框交出去的一律是内联形态：这里的 `dataUrl` 可能是本机字节，也可能还是画布里那句
   * `aip-media:<id>`。哪几张改成按 id 发由 `agentClient` 的 `resolveReferences` 在发送那一刻定。
   */
  readonly references: readonly AgentInlineReference[]
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
