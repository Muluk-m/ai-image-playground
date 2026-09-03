import type { InputImage } from '../types'

const MENTION_START = '\u2063'
const MENTION_END = '\u2064'
const SELECTED_IMAGE_MENTION_RE = /\u2063@图(\d+)\u2064/g

export interface AtImageQuery {
  start: number
  query: string
}

/** 胶囊的显示文本；null 表示该序号没有对应参考图，按普通文本渲染。 */
export type MentionLabelResolver = (imageIndex: number) => string | null

export function getImageMentionLabel(index: number) {
  return `@图${index + 1}`
}

export function getSelectedImageMentionLabel(index: number) {
  return `${MENTION_START}${getImageMentionLabel(index)}${MENTION_END}`
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

interface MentionSpan {
  visibleStart: number
  visibleEnd: number
  imageIndex: number
}

interface PromptScan {
  visible: string
  spans: MentionSpan[]
  /** 第 i 个可见字符在 prompt 里的下标；胶囊内的字符一律指向胶囊起点 */
  promptIndexAt: number[]
}

/**
 * 可见文本是渲染出来的那一串，胶囊按 `labelFor` 的显示标签计长——contentEditable 的光标
 * 偏移就是在这个坐标系里数的，两边不一致光标会整体错位。
 */
function scanPrompt(prompt: string, labelFor: MentionLabelResolver): PromptScan {
  const spans: MentionSpan[] = []
  const promptIndexAt: number[] = []
  const visible: string[] = []
  let plainFrom = 0

  const pushPlain = (to: number) => {
    for (let i = plainFrom; i < to; i++) {
      const char = prompt[i]
      if (char === MENTION_START || char === MENTION_END) continue
      promptIndexAt.push(i)
      visible.push(char)
    }
  }

  for (const match of prompt.matchAll(SELECTED_IMAGE_MENTION_RE)) {
    if (match.index == null) continue
    const imageIndex = Number(match[1]) - 1
    const label = labelFor(imageIndex)
    if (label == null) continue

    pushPlain(match.index)
    spans.push({
      visibleStart: visible.length,
      visibleEnd: visible.length + label.length,
      imageIndex,
    })
    for (let i = 0; i < label.length; i++) {
      promptIndexAt.push(match.index)
      visible.push(label[i])
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

export function imageMentionMatches(query: string, index: number) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true

  const oneBasedIndex = String(index + 1)
  const label = `图${oneBasedIndex}`
  return oneBasedIndex.includes(normalized) || label.toLowerCase().includes(normalized)
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

export function remapImageMentionsForOrder(
  prompt: string,
  previousImages: InputImage[],
  nextImages: InputImage[],
  equivalentImageIds: Record<string, string> = {},
): string {
  return prompt.replace(SELECTED_IMAGE_MENTION_RE, (text, n) => {
    const previousImage = previousImages[Number(n) - 1]
    if (!previousImage) return text

    const nextImageId = equivalentImageIds[previousImage.id] ?? previousImage.id
    const nextIndex = nextImages.findIndex((img) => img.id === nextImageId)
    return nextIndex >= 0 ? getSelectedImageMentionLabel(nextIndex) : '@已移除图片'
  })
}

export type PromptMentionPart =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; imageIndex: number }

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
    parts.push({
      type: 'mention',
      text: visible.slice(span.visibleStart, span.visibleEnd),
      imageIndex: span.imageIndex,
    })
    cursor = span.visibleEnd
  }
  if (cursor < visible.length) parts.push({ type: 'text', text: visible.slice(cursor) })

  return parts.length > 0 ? parts : [{ type: 'text', text: visible }]
}

export function replaceImageMentionsForApi(prompt: string, imageCount?: number): string {
  return prompt.replace(SELECTED_IMAGE_MENTION_RE, (text, n) => {
    const index = Number(n) - 1
    if (imageCount != null && (index < 0 || index >= imageCount))
      return stripImageMentionMarkers(text)
    return `[image ${n}]`
  })
}
