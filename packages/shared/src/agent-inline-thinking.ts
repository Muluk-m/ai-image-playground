/**
 * 有的对话模型会把旁白写成正文里的 `<thinking>…</thinking>`（或 `<think>…</think>`），
 * 而不是走推理通道。这段不是给用户看的回复：流式输出与已落库的历史都要把它去掉。
 *
 * 只认整段开头的标签名，大小写不敏感；没闭合的标签一直吞到消息结束（模型常常写了开头就去调工具）。
 */
const TAGS = ['thinking', 'think'] as const
const OPEN = /<(thinking|think)\s*>/i
const MAX_TAG_LENGTH = '</thinking >'.length

function closeTag(name: string) {
  return new RegExp(`</${name}\\s*>`, 'i')
}

/** 末尾这一截可能是某个标签的开头，要等下一段才知道。 */
function partialTagStart(text: string, closing?: string): number {
  const at = text.lastIndexOf('<')
  if (at < 0 || text.length - at > MAX_TAG_LENGTH) return -1
  const tail = text.slice(at).toLowerCase()
  const candidates = closing ? [`</${closing}`] : TAGS.map((tag) => `<${tag}`)
  for (const candidate of candidates) {
    if (candidate.startsWith(tail)) return at
    // `<thinking` 之后还可能跟空白再闭合 `>`。
    if (tail.startsWith(candidate) && /^\s*$/.test(tail.slice(candidate.length))) return at
  }
  return -1
}

/** 按流式分段过滤：`push` 返回这一段里可以显示的文字，`end` 交出消息结束时剩下的可见部分。 */
export class InlineThinkingFilter {
  private buffer = ''
  private inside: string | undefined

  push(delta: string): string {
    this.buffer += delta
    let visible = ''
    for (;;) {
      if (this.inside) {
        const close = closeTag(this.inside).exec(this.buffer)
        if (!close) {
          const keep = partialTagStart(this.buffer, this.inside)
          this.buffer = keep >= 0 ? this.buffer.slice(keep) : ''
          return visible
        }
        this.buffer = this.buffer.slice(close.index + close[0].length).replace(/^[ \t]*\r?\n?/, '')
        this.inside = undefined
        continue
      }
      const open = OPEN.exec(this.buffer)
      if (open) {
        visible += this.buffer.slice(0, open.index)
        this.buffer = this.buffer.slice(open.index + open[0].length)
        this.inside = open[1]!.toLowerCase()
        continue
      }
      const keep = partialTagStart(this.buffer)
      if (keep < 0) {
        visible += this.buffer
        this.buffer = ''
      } else {
        visible += this.buffer.slice(0, keep)
        this.buffer = this.buffer.slice(keep)
      }
      return visible
    }
  }

  end(): string {
    const rest = this.inside ? '' : this.buffer
    this.buffer = ''
    this.inside = undefined
    return rest
  }
}

/** 整段去掉内联思考标签；用于已落库的旧回复。 */
export function stripInlineThinking(text: string): string {
  if (!/<think/i.test(text)) return text
  const filter = new InlineThinkingFilter()
  return (filter.push(text) + filter.end()).trim()
}
