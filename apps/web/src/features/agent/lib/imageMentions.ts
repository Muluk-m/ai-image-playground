import { i18next } from '../../../i18n'

/** 这条消息里第 `index` 张参考图的界面标签，和发给模型的 `[image N]`、助手说的图 N 是同一个序号。 */
export function agentImageMentionLabel(index: number): string {
  return i18next.t('mentions.imageLabel', { ns: 'agent', n: index + 1 })
}

/**
 * 素材名如果就是图片 id，或一长串十六进制，不能拿来当界面文案。
 * 文件名、素材名这种人读得懂的留下；哈希只留在引用载荷里。
 */
export function isOpaqueImageName(name: string, imageId?: string): boolean {
  const trimmed = name.trim()
  if (imageId && trimmed === imageId) return true
  return /^[0-9a-f]{16,}$/i.test(trimmed)
}

/** 附件瓦片：人读得懂的名字留下（含同名编号），哈希和图片 id 换成序号标签。 */
export function referenceTileLabel(
  index: number,
  name: string | undefined,
  imageId: string,
  displayName?: string,
): string {
  if (name && !isOpaqueImageName(name, imageId)) return displayName ?? name
  return agentImageMentionLabel(index)
}

export interface StoredImageMention {
  readonly imageId: string
}

export interface ImageMentionSpan {
  readonly start: number
  readonly end: number
  readonly index: number
}

const IMAGE_TOKEN = /\[image ([1-9]\d*)\]/g

/**
 * 正文里要收成胶囊的区间：`[image N]`，以及恰好等于某张参考图 id 的 `@<id>`。
 * 序号是参考图在这条消息里的下标，不是出现次序。认不出的 `[image N]` 留在原文里。
 */
export function imageMentionSpans(
  text: string,
  references: readonly StoredImageMention[],
): ImageMentionSpan[] {
  const spans: ImageMentionSpan[] = []
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    if (match.index == null) continue
    const index = Number(match[1]) - 1
    if (!references[index]) continue
    spans.push({ start: match.index, end: match.index + match[0].length, index })
  }

  const ids = references
    .map((reference, index) => ({ id: reference.imageId, index }))
    .filter((one) => one.id.length > 0)
    .sort((a, b) => b.id.length - a.id.length || a.index - b.index)

  for (const { id, index } of ids) {
    const token = `@${id}`
    let from = 0
    while (from <= text.length - token.length) {
      const at = text.indexOf(token, from)
      if (at < 0) break
      const end = at + token.length
      const previous = text[at - 1]
      const next = text[end]
      const lead = previous === undefined || !/[0-9A-Za-z_.-]/.test(previous)
      const boundary = next === undefined || !/[0-9A-Za-z_-]/.test(next)
      const overlaps = spans.some((span) => at < span.end && end > span.start)
      if (lead && boundary && !overlaps) spans.push({ start: at, end, index })
      from = end
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  return spans
}

/** 重新编辑时把引用换成界面标签，不把图片 id 或 `@<hash>` 写回输入框。 */
export function editableImageMentionText(
  text: string,
  references: readonly StoredImageMention[],
): string {
  const spans = imageMentionSpans(text, references)
  let out = ''
  let from = 0
  for (const span of spans) {
    out += text.slice(from, span.start) + agentImageMentionLabel(span.index)
    from = span.end
  }
  return out + text.slice(from)
}
