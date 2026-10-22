/**
 * 有的对话模型不走推理通道，而是把旁白写在正文开头的 `<thinking>…</thinking>`（或 `<think>…</think>`）里。
 * 这一段是推理，不是回复：模型适配层把它拆成 thinking 块，正文、落库与原生历史里都不再有标签。
 *
 * 只认正文开头（允许前导空白）的标签。正文中间出现的同名标签是正文的一部分，原样保留，
 * 不能把后面的内容吞掉。开头的标签没有闭合时，到正文结束都算推理（模型常常写了开头就去调工具）。
 */

/** 默认识别的标签名；具体模型开不开、认哪几个由 BFF 的模型配置决定。 */
export const INLINE_REASONING_TAGS = ['thinking', 'think'] as const

export type InlineReasoningSplit =
  /** 开头还可能是标签，要等更多文字才知道；此刻什么都不显示。 */
  | { readonly state: 'pending' }
  /** 开头不是推理标签：整段原样是正文。 */
  | { readonly state: 'plain'; readonly text: string }
  /** 开头是推理标签。`closed` 为 false 时推理还没写完，`text` 必为空。 */
  | {
      readonly state: 'reasoning'
      readonly thinking: string
      readonly text: string
      readonly closed: boolean
    }

const OPEN = /^<([a-z]+)\s*>/i

function isTag(name: string, tags: readonly string[]): boolean {
  return tags.includes(name.toLowerCase())
}

/** 开头这一截还可能长成某个开标签：`<`、`<thi`、`<think`、`<think ` 都算。 */
function couldOpen(rest: string, tags: readonly string[]): boolean {
  if (rest === '') return true
  const lower = rest.toLowerCase()
  return tags.some((tag) => {
    const open = `<${tag}`
    if (open.startsWith(lower)) return true
    return lower.startsWith(open) && /^\s*$/.test(lower.slice(open.length))
  })
}

const WHITESPACE = /\s/

/**
 * 流式拆分器：同一段正文只会在末尾追加，每个字符只看一次，整段流的处理量与长度成正比。
 * 开头一旦定下来（是推理标签还是普通正文）就不再回头看；推理没闭合时，闭标签按字符逐个往后认，
 * 认到一半的候选（`</thi`、`</thinking   `）记住认到了哪，下一段从那里接着认。
 * 每次调用传入到目前为止的整段正文，结果与 `splitInlineReasoning` 对同一前缀的结果相同。
 */
export class InlineReasoningSplitter {
  private phase: 'pending' | 'plain' | 'open' | 'closed' = 'pending'
  /** 闭标签去掉末尾 `>` 的那一截，小写，如 `</thinking`。 */
  private close = ''
  /** 推理正文在整段里的起点。 */
  private bodyStart = 0
  /** 还可能长成闭标签的那个 `<` 的位置；-1 即眼下没有候选。 */
  private candidate = -1
  /** 下一个要看的字符：之前的都已经认过了。 */
  private cursor = 0
  private closeStart = 0
  private closeEnd = 0

  constructor(private readonly tags: readonly string[] = INLINE_REASONING_TAGS) {}

  split(text: string, finished: boolean): InlineReasoningSplit {
    if (this.phase === 'pending') this.decideStart(text, finished)
    if (this.phase === 'pending') return { state: 'pending' }
    if (this.phase === 'plain') return { state: 'plain', text }
    if (this.phase === 'open') this.scanClose(text)
    if (this.phase === 'closed')
      return {
        state: 'reasoning',
        thinking: text.slice(this.bodyStart, this.closeStart),
        text: text.slice(this.closeEnd).trimStart(),
        closed: true,
      }
    // 末尾认到一半的闭标签先扣下；正文写完了就还给推理。
    const held = !finished && this.candidate >= 0
    return {
      state: 'reasoning',
      thinking: text.slice(this.bodyStart, held ? this.candidate : text.length),
      text: '',
      closed: false,
    }
  }

  private decideStart(text: string, finished: boolean) {
    const lead = text.length - text.trimStart().length
    const rest = text.slice(lead)
    const open = OPEN.exec(rest)
    if (open && isTag(open[1]!, this.tags)) {
      this.phase = 'open'
      this.close = `</${open[1]!.toLowerCase()}`
      this.bodyStart = lead + open[0].length
      this.cursor = this.bodyStart
      return
    }
    if (!finished && couldOpen(rest, this.tags)) return
    this.phase = 'plain'
  }

  /** 从上次停下的字符接着认闭标签：`</name` 逐字对上，随后任意空白，最后一个 `>`。 */
  private scanClose(text: string) {
    while (this.cursor < text.length) {
      if (this.candidate < 0) {
        const at = text.indexOf('<', this.cursor)
        if (at < 0) {
          this.cursor = text.length
          return
        }
        this.candidate = at
        this.cursor = at
      }
      const char = text[this.cursor]!
      const offset = this.cursor - this.candidate
      const fits =
        offset < this.close.length
          ? char.toLowerCase() === this.close[offset]
          : char === '>' || WHITESPACE.test(char)
      if (!fits) {
        // 候选断了：闭标签里只有开头一个 `<`，所以断在这里的字符本身可能是下一个候选的开头。
        this.candidate = -1
        continue
      }
      if (offset >= this.close.length && char === '>') {
        this.phase = 'closed'
        this.closeStart = this.candidate
        this.closeEnd = this.cursor + 1
        return
      }
      this.cursor += 1
    }
  }
}

/**
 * 按到目前为止的整段正文拆分。`finished` 表示这段正文不会再长：仍待定的开头按正文处理，
 * 扣下的半截闭标签也还给推理。流式中各次结果单调增长（`thinking` 与 `text` 只会在末尾追加），
 * 调用方可以按差量下发；流式逐段拆分请用 `InlineReasoningSplitter`，不必每次从头扫。
 */
export function splitInlineReasoning(
  text: string,
  tags: readonly string[] = INLINE_REASONING_TAGS,
  finished = true,
): InlineReasoningSplit {
  return new InlineReasoningSplitter(tags).split(text, finished)
}

/** 只要正文：给修复前已经落库的旧回复兜底，或回放产品历史时用。 */
export function stripInlineReasoning(
  text: string,
  tags: readonly string[] = INLINE_REASONING_TAGS,
): string {
  const split = splitInlineReasoning(text, tags, true)
  return split.state === 'plain' ? text : split.state === 'reasoning' ? split.text : ''
}
