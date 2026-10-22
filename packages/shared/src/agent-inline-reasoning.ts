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

/** 推理正文末尾可能是半截闭标签，流式时先扣下，等下一段再判断。 */
function heldCloseStart(body: string, name: string): number {
  const at = body.lastIndexOf('<')
  if (at < 0) return body.length
  const tail = body.slice(at).toLowerCase()
  const close = `</${name}`
  if (close.startsWith(tail)) return at
  if (tail.startsWith(close) && /^\s*$/.test(tail.slice(close.length))) return at
  return body.length
}

/**
 * 按到目前为止的整段正文拆分。`finished` 表示这段正文不会再长：仍待定的开头按正文处理，
 * 扣下的半截闭标签也还给推理。流式中各次结果单调增长（`thinking` 与 `text` 只会在末尾追加），
 * 调用方可以按差量下发。
 */
export function splitInlineReasoning(
  text: string,
  tags: readonly string[] = INLINE_REASONING_TAGS,
  finished = true,
): InlineReasoningSplit {
  const lead = text.length - text.trimStart().length
  const rest = text.slice(lead)
  const open = OPEN.exec(rest)
  if (open && isTag(open[1]!, tags)) {
    const name = open[1]!.toLowerCase()
    const body = rest.slice(open[0].length)
    const close = new RegExp(`</${name}\\s*>`, 'i').exec(body)
    if (close)
      return {
        state: 'reasoning',
        thinking: body.slice(0, close.index),
        text: body.slice(close.index + close[0].length).trimStart(),
        closed: true,
      }
    return {
      state: 'reasoning',
      thinking: finished ? body : body.slice(0, heldCloseStart(body, name)),
      text: '',
      closed: false,
    }
  }
  if (!finished && couldOpen(rest, tags)) return { state: 'pending' }
  return { state: 'plain', text }
}

/** 只要正文：给修复前已经落库的旧回复兜底，或回放产品历史时用。 */
export function stripInlineReasoning(
  text: string,
  tags: readonly string[] = INLINE_REASONING_TAGS,
): string {
  const split = splitInlineReasoning(text, tags, true)
  return split.state === 'plain' ? text : split.state === 'reasoning' ? split.text : ''
}
