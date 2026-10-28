import type { AgentMessageView } from './agent'

/**
 * 助手正文偶发夹进用户没用过的文字（BUG-22：中文回复里冒出古吉拉特文「પરિણામ」）。
 * 模型参数没有语言开关，系统提示只能降低概率。这里在出站前把不该出现的字母去掉。
 *
 * 中文、英文、注音、假名、谚文、希腊字母，以及数字、标点、符号、表情一律保留。
 * 这些和中文常混排，逐字删会把「見る」削成「見」、把「α 通道」削成「通道」。
 * 其余字母默认删掉。用户用过某个文字系统里的任意一个字，就保留整个文字系统，
 * 这样俄文或阿拉伯文回复不会因为缺了几个没打过的字母变成残句。古吉拉特文这类从未出现过的仍删。
 * 允许的文字系统在每轮开始时算一次，流式增量不再重算。不额外调用模型。
 */

/** 整段回复都落在不该出现的文字里时，换成这一句，而不是把气泡留空。 */
export const REPLY_SCRIPT_FALLBACK_ZH = '回复语言异常，请再试一次。'
export const REPLY_SCRIPT_FALLBACK_EN = 'That reply came back in an unexpected language. Try again.'

/**
 * 常驻保留。假名、谚文、希腊字母和中英文一样不删，避免「用日语回答」把「見る」削成「見」。
 * 不在这里的字母默认删。用户用过的文字系统整表放行，不是只放行打过的那几个字。
 */
const ALWAYS_KEPT =
  /[\p{Script=Latin}\p{Script=Han}\p{Script=Bopomofo}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/u

/** 认出用户原文属于哪种文字。常驻保留的不在这里。 */
const OTHER_SCRIPTS = [
  'Adlam',
  'Arabic',
  'Armenian',
  'Bengali',
  'Canadian_Aboriginal',
  'Cherokee',
  'Coptic',
  'Cyrillic',
  'Deseret',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Gujarati',
  'Gurmukhi',
  'Hebrew',
  'Javanese',
  'Kannada',
  'Khmer',
  'Lao',
  'Malayalam',
  'Mongolian',
  'Myanmar',
  'Nko',
  'Oriya',
  'Sinhala',
  'Sundanese',
  'Syriac',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
  'Tifinagh',
  'Vai',
  'Yi',
] as const

type OtherScript = (typeof OTHER_SCRIPTS)[number]

const DROPPABLE = /[\p{L}\p{M}\p{N}]/u
const HAN = /\p{Script=Han}/u
const LATIN = /\p{Script=Latin}/u

const scriptPattern = new Map<OtherScript, RegExp>(
  OTHER_SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]),
)

/** 这一轮允许出现的非常驻文字。extra 为 null 表示用户没用过这些文字。 */
export interface ReplyScriptAllowance {
  readonly extra: RegExp | null
}

const NO_EXTRA: ReplyScriptAllowance = { extra: null }

function scriptOf(char: string): OtherScript | null {
  for (const name of OTHER_SCRIPTS) {
    if (scriptPattern.get(name)!.test(char)) return name
  }
  return null
}

/** 每轮开始时算一次。流式增量只拿这份结果，不再扫用户原文。 */
export function compileReplyScripts(userText: string): ReplyScriptAllowance {
  const names: OtherScript[] = []
  for (const char of userText) {
    if (ALWAYS_KEPT.test(char) || !DROPPABLE.test(char)) continue
    const name = scriptOf(char)
    if (name && !names.includes(name)) names.push(name)
  }
  if (names.length === 0) return NO_EXTRA
  return {
    extra: new RegExp(`[${names.map((name) => `\\p{Script=${name}}`).join('')}]`, 'u'),
  }
}

function isDropped(char: string, extra: RegExp | null): boolean {
  if (ALWAYS_KEPT.test(char) || extra?.test(char)) return false
  return DROPPABLE.test(char)
}

/** 流式闸门和历史读回共用这一份：整段会话里的用户原文，再加这一轮还没落进历史的那句。 */
export function collectUserReplyText(
  messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[],
  current = '',
): string {
  const parts = messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((block) =>
          block.type === 'text' && block.text ? [block.text] : [],
        )
      : [],
  )
  if (current.trim()) parts.push(current)
  return parts.join('\n')
}

function hasLetter(text: string): boolean {
  return /\p{L}/u.test(text)
}

/** 数字、表情、货币符号都算正文。只剩空白和标点时才考虑兜底。 */
function hasPayload(text: string): boolean {
  return /[^\p{P}\p{Z}\p{C}]/u.test(text)
}

function stripBody(text: string, extra: RegExp | null): string {
  const chars = [...text]
  let out = ''
  let index = 0
  while (index < chars.length) {
    const char = chars[index]!
    if (isDropped(char, extra)) {
      index += 1
      while (index < chars.length && isDropped(chars[index]!, extra)) index += 1
      if (out.endsWith(' ')) {
        while (index < chars.length && chars[index] === ' ') index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

function replyFallback(userText: string): string {
  let han = 0
  let latin = 0
  for (const char of userText) {
    if (HAN.test(char)) han += 1
    else if (LATIN.test(char)) latin += 1
  }
  return latin > han ? REPLY_SCRIPT_FALLBACK_EN : REPLY_SCRIPT_FALLBACK_ZH
}

/** 只删除不该出现的文字，不把整段换成兜底句。建议句用这条：整句都是杂字就丢掉。 */
export function stripDisallowedScripts(text: string, userText = ''): string {
  return stripBody(text, compileReplyScripts(userText).extra)
}

export function stripWithReplyScripts(text: string, allowance: ReplyScriptAllowance): string {
  return stripBody(text, allowance.extra)
}

export interface ReplyScriptGate {
  /** 吃进一段模型增量，返回可以追加给用户的那一截。空串表示还没有看得见的正文。 */
  push(delta: string): string
  /**
   * 正文结束。洗完只剩空白和标点、原文里却有被删掉的字母时，返回兜底句。
   * `fallback` 为假（用户中止）时只交出已经能确定的正文，不补这句。
   */
  finish(fallback?: boolean): string
  text(): string
}

export function createReplyScriptGate(
  userText: string,
  /** 缺席时现算。一轮里多次开口应传入轮初那一份，避免每个增量重算。 */
  allowance: ReplyScriptAllowance = compileReplyScripts(userText),
): ReplyScriptGate {
  const extra = allowance.extra
  const fallback = replyFallback(userText)
  let raw = ''
  /** 已经扫过的 UTF-16 下标。尾部单独的高位代理先留着，等下一片把字拼完整。 */
  let scanned = 0
  let body = ''
  let rawHadLetter = false
  /** 刚删掉的词左边已经有空格：后面的空格即使在下一片才到，也要收掉一个。 */
  let skipSpaces = false
  let safe = ''
  let sealed = false
  const consume = (end: number) => {
    if (end <= scanned) return
    const chars = [...raw.slice(scanned, end)]
    let index = 0
    while (index < chars.length) {
      const char = chars[index]!
      if (hasLetter(char)) rawHadLetter = true
      if (isDropped(char, extra)) {
        index += 1
        while (index < chars.length && isDropped(chars[index]!, extra)) {
          if (hasLetter(chars[index]!)) rawHadLetter = true
          index += 1
        }
        skipSpaces = body.endsWith(' ')
        if (skipSpaces) {
          while (index < chars.length && chars[index] === ' ') index += 1
        }
        continue
      }
      if (skipSpaces && char === ' ') {
        index += 1
        continue
      }
      skipSpaces = false
      body += char
      index += 1
    }
    scanned = end
  }
  // 只扫新增的完整码位，不把已经扫过的前缀再扫一遍。
  const scan = (includeTail: boolean) => {
    let end = raw.length
    if (!includeTail && end > scanned) {
      const last = raw.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    consume(end)
  }
  const publish = (next: string): string => {
    // 清洗只在末尾追加：先发出去的字不会被收回。做不到时宁可不再往外补，避免气泡里出现两遍。
    if (!next.startsWith(safe)) return ''
    const piece = next.slice(safe.length)
    safe = next
    return piece
  }
  return {
    push(delta) {
      if (sealed || !delta) return ''
      raw += delta
      scan(false)
      // 只剩标点时先别开气泡：后面若全是杂字，收尾要换成兜底句，不能把句号先发出去。
      if (!hasPayload(body)) return ''
      return publish(body)
    },
    finish(allowFallback = true) {
      if (sealed) return ''
      sealed = true
      scan(true)
      const next = allowFallback && !hasPayload(body) && rawHadLetter ? fallback : body
      return publish(next)
    },
    text() {
      return safe
    },
  }
}

/** 给用户看的助手正文：清掉杂字；清完什么都不剩就换一句兜底。 */
export function sanitizeReplyText(text: string, userText = ''): string {
  const gate = createReplyScriptGate(userText)
  gate.push(text)
  gate.finish()
  return gate.text()
}

/**
 * 历史读回时再清一次。允许哪些泄漏文字，看这批消息里的全部用户原文，
 * 和流式闸门的 `collectUserReplyText` 是同一套，避免直播保留、刷新又删。
 * 只删，不换成兜底句。
 */
export function sanitizeAssistantMessages(
  messages: readonly AgentMessageView[],
): AgentMessageView[] {
  const userText = collectUserReplyText(messages)
  const extra = compileReplyScripts(userText).extra
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    let blockChanged = false
    const content = message.content.map((block) => {
      if (block.type !== 'text' || !block.text) return block
      const text = stripBody(block.text, extra)
      if (text === block.text) return block
      blockChanged = true
      return { ...block, text }
    })
    if (!blockChanged) return message
    changed = true
    return { ...message, content }
  })
  return changed ? next : (messages as AgentMessageView[])
}
