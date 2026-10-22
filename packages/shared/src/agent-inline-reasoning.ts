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

/**
 * 推理正文从 `at`（一个 `<`）到末尾这一截可能是半截闭标签：流式时先扣下，等下一段再判断。
 * 不匹配时在第一个不对的字符处就返回，不会把整段尾巴再扫一遍。
 */
function isHeldClose(text: string, at: number, name: string): boolean {
  const close = `</${name}`
  const head = Math.min(close.length, text.length - at)
  if (text.slice(at, at + head).toLowerCase() !== close.slice(0, head)) return false
  for (let index = at + head; index < text.length; index++)
    if (!/\s/.test(text[index]!)) return false
  return true
}

/**
 * 流式拆分器：同一段正文只会在末尾追加，每次只看新增的部分，整段流的处理量与长度成正比。
 * 开头一旦定下来（是推理标签还是普通正文）就不再回头看；推理没闭合时只从上次扫到的位置往后找闭标签。
 * 每次调用传入到目前为止的整段正文，结果与 `splitInlineReasoning` 对同一前缀的结果相同。
 */
export class InlineReasoningSplitter {
  private phase: 'pending' | 'plain' | 'open' | 'closed' = 'pending'
  private name = ''
  /** 推理正文在整段里的起点。 */
  private bodyStart = 0
  /** 还没找到闭标签时，下次从这里往后找；它要么是正文末尾，要么是末尾那个还可能长成闭标签的 `<`。 */
  private scanFrom = 0
  private closeStart = 0
  private closeEnd = 0
  private closeRe: RegExp | undefined

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
    const held = !finished && this.scanFrom < text.length
    return {
      state: 'reasoning',
      thinking: text.slice(this.bodyStart, held ? this.scanFrom : text.length),
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
      this.name = open[1]!.toLowerCase()
      this.bodyStart = lead + open[0].length
      this.scanFrom = this.bodyStart
      this.closeRe = new RegExp(`</${this.name}\\s*>`, 'gi')
      return
    }
    if (!finished && couldOpen(rest, this.tags)) return
    this.phase = 'plain'
  }

  private scanClose(text: string) {
    const re = this.closeRe!
    re.lastIndex = this.scanFrom
    const close = re.exec(text)
    if (close) {
      this.phase = 'closed'
      this.closeStart = close.index
      this.closeEnd = close.index + close[0].length
      return
    }
    // 没闭合：闭标签里只有一个 `<`，能长成闭标签的只可能是最后一个 `<`；它已经不可能是闭标签，
    // 以后也不会是（前缀不对或后面跟了别的字），下次就从末尾接着找。
    let last = -1
    for (let at = text.indexOf('<', this.scanFrom); at >= 0; at = text.indexOf('<', at + 1))
      last = at
    this.scanFrom = last >= 0 && isHeldClose(text, last, this.name) ? last : text.length
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
