import { i18next } from '../i18n'
import type { InputImage } from '../types'

const MENTION_START = '\u2063'
const MENTION_END = '\u2064'
const SELECTED_IMAGE_MENTION_RE = /\u2063@图(\d+)\u2064/g
/**
 * 素材位（CONTEXT「素材位」）的存储形态：U+2066 key [+] U+2067 位名 U+2067 [引用哨兵…] U+2069。填好的位里装的就是普通引用哨兵，
 * 重排、去重、降级都走引用那一套；空位里什么都没装，发送时以位名作普通文字发出。`+` 表示能放多图。
 * 位名是初值文案：按填入那一刻的界面语言写，之后不再翻译。
 */
const ASSET_SLOT_SOURCE =
  '\u2066([A-Za-z0-9_-]+)(\\+?)\u2067([^\u2063-\u2069]*)\u2067((?:\u2063@图\\d+\u2064)*)\u2069'
const ASSET_SLOT_RE = new RegExp(ASSET_SLOT_SOURCE, 'g')
/** 位与位外的引用一起扫：位里的引用归位管，不再单独成一个胶囊。 */
const PROMPT_TOKEN_RE = new RegExp(`${ASSET_SLOT_SOURCE}|${SELECTED_IMAGE_MENTION_RE.source}`, 'g')

export interface AtImageQuery {
  start: number
  query: string
}

/** 胶囊的显示文本；null 表示该序号没有对应参考图，按普通文本渲染。 */
export type MentionLabelResolver = (imageIndex: number) => string | null

/** 胶囊上显示的序号标签，界面文案，随界面语言变。写进提示词的永远是下面的哨兵。 */
export function getImageMentionLabel(index: number) {
  return i18next.t('mention.imageLabel', { ns: 'lib', n: index + 1 })
}

/** 哨兵标记：存储格式，`@图N` 与界面语言无关，改它等于改历史记录、模板和同步数据的格式。 */
export function getSelectedImageMentionLabel(index: number) {
  return `${MENTION_START}@图${index + 1}${MENTION_END}`
}

/** `labelByImageId` 给图片起的名字优先于序号；提示词里存的仍是按序号的哨兵标记。 */
export function createMentionLabels(
  inputImages: InputImage[],
  labelByImageId: Record<string, string> = {},
): MentionLabelResolver {
  return (index) => {
    const image = inputImages[index]
    if (!image) return null
    const named = labelByImageId[image.id]
    return named ? `@${named}` : getImageMentionLabel(index)
  }
}

function stripImageMentionMarkers(prompt: string): string {
  return prompt.replace(/[\u2063\u2064]/g, '')
}

/** 提示词里的一个素材位。`imageIndexes` 为空即空位。 */
export interface PromptAssetSlot {
  readonly key: string
  /** 位名：空位与已填位的胶囊都按它的长度计光标。 */
  readonly label: string
  readonly multiple: boolean
  readonly imageIndexes: readonly number[]
}

export interface PromptAssetSlotDeclaration {
  readonly key: string
  readonly label: string
  readonly multiple: boolean
}

/** 位名里不许出现任何哨兵字符，否则存储形态就拆不回来。 */
function slotLabelText(label: string): string {
  return label.replace(/[\u2063-\u2069]/g, '')
}

/** 一个素材位的存储形态；`imageIndexes` 是填进去的参考图序号，空数组即空位。 */
export function assetSlotToken(
  slot: PromptAssetSlotDeclaration,
  imageIndexes: readonly number[] = [],
): string {
  const mentions = imageIndexes.map(getSelectedImageMentionLabel).join('')
  return `\u2066${slot.key}${slot.multiple ? '+' : ''}\u2067${slotLabelText(slot.label)}\u2067${mentions}\u2069`
}

function slotFromMatch(match: RegExpMatchArray): PromptAssetSlot {
  return {
    key: match[1]!,
    multiple: match[2] === '+',
    label: match[3]!,
    imageIndexes: getMentionedImageIndexes(match[4] ?? ''),
  }
}

/** 提示词里的素材位，按出现顺序；同一个位在提示词里的身份就是它在这份清单里的下标。 */
export function getPromptAssetSlots(prompt: string): PromptAssetSlot[] {
  return [...prompt.matchAll(ASSET_SLOT_RE)].map(slotFromMatch)
}

/** 换掉第 `occurrence` 个素材位里装的图；空数组即把它变回空位。 */
export function setPromptAssetSlotImages(
  prompt: string,
  occurrence: number,
  imageIndexes: readonly number[],
): string {
  let at = 0
  return prompt.replace(ASSET_SLOT_RE, (...match: string[]) => {
    if (at++ !== occurrence) return match[0]!
    return assetSlotToken(slotFromMatch(match as unknown as RegExpMatchArray), imageIndexes)
  })
}

interface MentionSpan {
  visibleStart: number
  visibleEnd: number
  /** 素材位是 -1：它不指向某一张图。 */
  imageIndex: number
  slot?: PromptAssetSlot & { readonly token: string; readonly occurrence: number }
}

interface PromptScan {
  visible: string
  spans: MentionSpan[]
  /** 第 i 个可见字符在 prompt 里的下标；胶囊内的字符一律指向胶囊起点 */
  promptIndexAt: number[]
}

/**
 * 可见文本是渲染出来的那一串，胶囊按 `labelFor` 的显示标签计长——contentEditable 的光标
 * 偏移就是在这个坐标系里数的，两边不一致光标会整体错位。素材位不论空着还是填好都按位名计长。
 */
function scanPrompt(prompt: string, labelFor: MentionLabelResolver): PromptScan {
  const spans: MentionSpan[] = []
  const promptIndexAt: number[] = []
  const visible: string[] = []
  let plainFrom = 0
  let slots = 0

  const pushPlain = (to: number) => {
    for (let i = plainFrom; i < to; i++) {
      const char = prompt[i]!
      if (char >= MENTION_START && char <= '\u2069') continue
      promptIndexAt.push(i)
      visible.push(char)
    }
  }

  for (const match of prompt.matchAll(PROMPT_TOKEN_RE)) {
    if (match.index == null) continue
    const slot = match[1] ? slotFromMatch(match) : undefined
    const imageIndex = slot ? -1 : Number(match[5]) - 1
    const label = slot ? slot.label || slot.key : labelFor(imageIndex)
    if (label == null) continue

    pushPlain(match.index)
    spans.push({
      visibleStart: visible.length,
      visibleEnd: visible.length + label.length,
      imageIndex,
      ...(slot ? { slot: { ...slot, token: match[0], occurrence: slots++ } } : {}),
    })
    for (let i = 0; i < label.length; i++) {
      promptIndexAt.push(match.index)
      visible.push(label[i]!)
    }
    plainFrom = match.index + match[0].length
  }
  pushPlain(prompt.length)

  return { visible: visible.join(''), spans, promptIndexAt }
}

export function getVisiblePrompt(prompt: string, labelFor: MentionLabelResolver): string {
  return scanPrompt(prompt, labelFor).visible
}

export function getPromptIndexFromVisibleIndex(
  prompt: string,
  visibleIndex: number,
  labelFor: MentionLabelResolver,
): number {
  return scanPrompt(prompt, labelFor).promptIndexAt[visibleIndex] ?? prompt.length
}

export function isCursorInSelectedImageMention(
  prompt: string,
  visibleCursor: number,
  labelFor: MentionLabelResolver,
): boolean {
  return scanPrompt(prompt, labelFor).spans.some(
    (span) => visibleCursor > span.visibleStart && visibleCursor <= span.visibleEnd,
  )
}

export function getAtImageQuery(prompt: string, cursor: number): AtImageQuery | null {
  const beforeCursor = prompt.slice(0, cursor)
  const atIndex = beforeCursor.lastIndexOf('@')
  if (atIndex < 0) return null

  const query = beforeCursor.slice(atIndex + 1)
  if (/\s/.test(query)) return null
  return { start: atIndex, query }
}

/** 提示词里出现过的参考图序号，去重后按出现顺序。 */
export function getMentionedImageIndexes(prompt: string): number[] {
  const indexes: number[] = []
  for (const match of prompt.matchAll(SELECTED_IMAGE_MENTION_RE)) {
    const index = Number(match[1]) - 1
    if (!indexes.includes(index)) indexes.push(index)
  }
  return indexes
}

export function imageMentionMatches(query: string, index: number) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true

  // 不分界面语言：中文用户会打 image，英文用户也可能从别处学来「图」。
  const oneBasedIndex = String(index + 1)
  return [oneBasedIndex, `图${oneBasedIndex}`, `image${oneBasedIndex}`].some((candidate) =>
    candidate.includes(normalized),
  )
}

/**
 * `nextLabelFor` 是插入后编辑器会显示的那套标签——附加素材会改变胶囊标签的长度，
 * 用旧标签算光标就会落偏。
 */
export function insertImageMentionAtVisibleRange(
  prompt: string,
  start: number,
  cursor: number,
  imageIndex: number,
  labelFor: MentionLabelResolver,
  nextLabelFor: MentionLabelResolver = labelFor,
) {
  const { promptIndexAt } = scanPrompt(prompt, labelFor)
  const promptStart = promptIndexAt[start] ?? prompt.length
  const promptCursor = promptIndexAt[cursor] ?? prompt.length
  const mention = getSelectedImageMentionLabel(imageIndex)
  const nextPrompt = `${prompt.slice(0, promptStart)}${mention}${prompt.slice(promptCursor)}`
  return {
    prompt: nextPrompt,
    cursor: getVisiblePrompt(nextPrompt.slice(0, promptStart + mention.length), nextLabelFor)
      .length,
  }
}

/**
 * `nextIndexOf` 给出新序号，负数表示图已不在条里，null 表示这条引用不归本次重排管。
 * 素材位里的引用不降级成文字：图不在了，位就少装一张，装空了就回到空位。
 */
export function remapImageMentions(
  prompt: string,
  nextIndexOf: (imageIndex: number) => number | null,
): string {
  return prompt.replace(PROMPT_TOKEN_RE, (...match: string[]) => {
    const [text, key, , , , n] = match
    if (key) {
      const slot = slotFromMatch(match as unknown as RegExpMatchArray)
      const kept = slot.imageIndexes.flatMap((index) => {
        const next = nextIndexOf(index)
        return next == null ? [index] : next >= 0 ? [next] : []
      })
      return assetSlotToken(slot, kept)
    }
    const nextIndex = nextIndexOf(Number(n) - 1)
    if (nextIndex == null) return text!
    // 初值文案：按写入这一刻的界面语言写，写完就是用户提示词里的普通文字。
    return nextIndex >= 0
      ? getSelectedImageMentionLabel(nextIndex)
      : i18next.t('mention.removedImage', { ns: 'lib' })
  })
}

export function remapImageMentionsForOrder(
  prompt: string,
  previousImages: InputImage[],
  nextImages: InputImage[],
  equivalentImageIds: Record<string, string> = {},
): string {
  return remapImageMentions(prompt, (imageIndex) => {
    const previousImage = previousImages[imageIndex]
    if (!previousImage) return null

    const nextImageId = equivalentImageIds[previousImage.id] ?? previousImage.id
    return nextImages.findIndex((img) => img.id === nextImageId)
  })
}

export type PromptMentionPart =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; imageIndex: number }
  | {
      type: 'slot'
      text: string
      /** 这一位在提示词里的存储形态，胶囊的 `data-mention-text` 就是它。 */
      token: string
      /** 第几个素材位，按出现顺序。 */
      occurrence: number
      slot: PromptAssetSlot
    }

export function getPromptMentionParts(
  prompt: string,
  labelFor: MentionLabelResolver,
): PromptMentionPart[] {
  const { visible, spans } = scanPrompt(prompt, labelFor)
  const parts: PromptMentionPart[] = []
  let cursor = 0

  for (const span of spans) {
    if (span.visibleStart > cursor) {
      parts.push({ type: 'text', text: visible.slice(cursor, span.visibleStart) })
    }
    const text = visible.slice(span.visibleStart, span.visibleEnd)
    if (span.slot) {
      const { token, occurrence, ...slot } = span.slot
      parts.push({ type: 'slot', text, token, occurrence, slot })
    } else {
      parts.push({ type: 'mention', text, imageIndex: span.imageIndex })
    }
    cursor = span.visibleEnd
  }
  if (cursor < visible.length) parts.push({ type: 'text', text: visible.slice(cursor) })

  return parts.length > 0 ? parts : [{ type: 'text', text: visible }]
}

/**
 * 发送形状：引用换成 `[image N]`。填好的素材位就是它装的那几条引用；空位以位名作普通文字发出，
 * 缺的图由智能体追问。
 */
export function replaceImageMentionsForApi(prompt: string, imageCount?: number): string {
  const mention = (text: string, n: string) => {
    const index = Number(n) - 1
    if (imageCount != null && (index < 0 || index >= imageCount))
      return stripImageMentionMarkers(text)
    return `[image ${n}]`
  }
  return prompt.replace(PROMPT_TOKEN_RE, (...match: string[]) => {
    const [text, key, , label, mentions, n] = match
    if (!key) return mention(text!, n!)
    const sent = [...(mentions ?? '').matchAll(SELECTED_IMAGE_MENTION_RE)].map((one) =>
      mention(one[0], one[1]!),
    )
    return sent.length > 0 ? sent.join(' ') : label || key
  })
}
