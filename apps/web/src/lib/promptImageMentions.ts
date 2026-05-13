import type { InputImage } from '../types'

const MENTION_START = '\u2063'
const MENTION_END = '\u2064'
const SELECTED_IMAGE_MENTION_RE = /\u2063@图(\d+)\u2064/g

export interface AtImageQuery {
  start: number
  query: string
}

export function getImageMentionLabel(index: number) {
  return `@图${index + 1}`
}

export function getSelectedImageMentionLabel(index: number) {
  return `${MENTION_START}${getImageMentionLabel(index)}${MENTION_END}`
}

export function stripImageMentionMarkers(prompt: string): string {
  return prompt.replace(/[\u2063\u2064]/g, '')
}

export function getPromptIndexFromVisibleIndex(prompt: string, visibleIndex: number): number {
  let visible = 0
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i] === MENTION_START || prompt[i] === MENTION_END) continue
    if (visible >= visibleIndex) return i
    visible++
  }
  return prompt.length
}

export function isCursorInSelectedImageMention(prompt: string, visibleCursor: number): boolean {
  for (const match of prompt.matchAll(SELECTED_IMAGE_MENTION_RE)) {
    if (match.index == null) continue
    const visibleStart = stripImageMentionMarkers(prompt.slice(0, match.index)).length
    const visibleEnd = visibleStart + getImageMentionLabel(Number(match[1]) - 1).length
    if (visibleCursor > visibleStart && visibleCursor <= visibleEnd) return true
  }
  return false
}

export function getAtImageQuery(prompt: string, cursor: number, inputImages: InputImage[]): AtImageQuery | null {
  if (inputImages.length === 0) return null

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

export function insertImageMention(prompt: string, start: number, cursor: number, imageIndex: number) {
  const mention = getSelectedImageMentionLabel(imageIndex)
  const visibleMention = getImageMentionLabel(imageIndex)
  const nextPrompt = `${prompt.slice(0, start)}${mention}${prompt.slice(cursor)}`
  return {
    prompt: nextPrompt,
    cursor: start + visibleMention.length,
  }
}

export function insertImageMentionAtVisibleRange(prompt: string, start: number, cursor: number, imageIndex: number) {
  const promptStart = getPromptIndexFromVisibleIndex(prompt, start)
  const promptCursor = getPromptIndexFromVisibleIndex(prompt, cursor)
  const mention = getSelectedImageMentionLabel(imageIndex)
  const visibleMention = getImageMentionLabel(imageIndex)
  return {
    prompt: `${prompt.slice(0, promptStart)}${mention}${prompt.slice(promptCursor)}`,
    cursor: start + visibleMention.length,
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

export function getPromptMentionParts(prompt: string, inputImages: InputImage[]): PromptMentionPart[] {
  const parts: PromptMentionPart[] = []
  let lastIndex = 0

  for (const match of prompt.matchAll(SELECTED_IMAGE_MENTION_RE)) {
    const text = getImageMentionLabel(Number(match[1]) - 1)
    const index = Number(match[1]) - 1
    if (!inputImages[index] || match.index == null) continue

    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: stripImageMentionMarkers(prompt.slice(lastIndex, match.index)) })
    }
    parts.push({ type: 'mention', text, imageIndex: index })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < prompt.length) {
    parts.push({ type: 'text', text: stripImageMentionMarkers(prompt.slice(lastIndex)) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: stripImageMentionMarkers(prompt) }]
}

export function replaceImageMentionsForApi(prompt: string, imageCount?: number): string {
  return prompt.replace(SELECTED_IMAGE_MENTION_RE, (text, n) => {
    const index = Number(n) - 1
    if (imageCount != null && (index < 0 || index >= imageCount)) return stripImageMentionMarkers(text)
    return `[image ${n}]`
  })
}
