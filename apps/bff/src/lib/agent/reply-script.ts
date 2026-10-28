import type { AgentMessageView } from '@image-playground/shared'

/**
 * 助手正文偶发夹进用户没用过的文字（BUG-22：中文回复里冒出古吉拉特文「પરિણામ」）。
 * 模型参数没有语言开关，系统提示只能降低概率。这里在出站前把不该出现的字母去掉。
 *
 * 始终保留中文、英文、注音，以及数字、标点、符号、表情。英文代码、模型名因此留得住。
 * 不按代码围栏豁免：围栏里的杂字同样删掉，避免流式回扫时把已经发出的正文改掉。
 * 用户原文里出现过的文字系统也保留。不额外调用模型。
 */

/** 整段回复都落在不该出现的文字里时，换成这一句，而不是把气泡留空。 */
export const REPLY_SCRIPT_FALLBACK_ZH = '回复语言异常，请再试一次。'
export const REPLY_SCRIPT_FALLBACK_EN = 'That reply came back in an unexpected language. Try again.'

/**
 * 用户原文里可能出现、因此允许进入回复的文字。不在这张表里的文字系统即使用户写了也会被去掉；
 * 表覆盖常见自然语言与线上见过的泄漏（古吉拉特、天城、泰、阿拉伯、西里尔、谚文、假名）。
 */
const EXTRA_SCRIPTS = [
  'Arabic',
  'Armenian',
  'Bengali',
  'Canadian_Aboriginal',
  'Cherokee',
  'Coptic',
  'Cyrillic',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Greek',
  'Gujarati',
  'Gurmukhi',
  'Hangul',
  'Hebrew',
  'Hiragana',
  'Kannada',
  'Katakana',
  'Khmer',
  'Lao',
  'Malayalam',
  'Mongolian',
  'Myanmar',
  'Oriya',
  'Sinhala',
  'Syriac',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
  'Yi',
] as const

type ExtraScript = (typeof EXTRA_SCRIPTS)[number]

const BASE_KEPT =
  /[\p{Script=Latin}\p{Script=Han}\p{Script=Bopomofo}\p{Script=Common}\p{Script=Inherited}]/u
const DROPPABLE = /[\p{L}\p{M}\p{N}]/u
const HAN = /\p{Script=Han}/u
const LATIN = /\p{Script=Latin}/u

const scriptPattern = new Map<ExtraScript, RegExp>(
  EXTRA_SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]),
)

function extraPattern(userText: string): RegExp | null {
  const names: ExtraScript[] = []
  for (const char of userText) {
    if (BASE_KEPT.test(char) || !DROPPABLE.test(char)) continue
    const name = EXTRA_SCRIPTS.find((script) => scriptPattern.get(script)!.test(char))
    if (name && !names.includes(name)) names.push(name)
  }
  if (names.length === 0) return null
  return new RegExp(`[${names.map((name) => `\\p{Script=${name}}`).join('')}]`, 'u')
}

function isDropped(char: string, extra: RegExp | null): boolean {
  if (BASE_KEPT.test(char) || extra?.test(char)) return false
  return DROPPABLE.test(char)
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
  return stripBody(text, extraPattern(userText))
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

export function createReplyScriptGate(userText: string): ReplyScriptGate {
  const extra = extraPattern(userText)
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
 * 历史读回时再清一次。旧回复已经落库的杂字因此不会再显示，也不会被回放给模型照抄。
 * 只认同一轮里的用户原文：压缩窗口没带上那一轮的用户消息时不动，避免把整段日文删掉。
 * 同一轮对得上时照样删，哪怕删完只剩标点，也不换成兜底句。
 */
export function sanitizeAssistantMessages(
  messages: readonly AgentMessageView[],
): AgentMessageView[] {
  const userTextByTurn = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    if (!text) continue
    const previous = userTextByTurn.get(message.turnId)
    userTextByTurn.set(message.turnId, previous ? `${previous}\n${text}` : text)
  }
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const userText = userTextByTurn.get(message.turnId)
    if (!userText?.trim()) return message
    let blockChanged = false
    const content = message.content.map((block) => {
      if (block.type !== 'text' || !block.text) return block
      const text = stripDisallowedScripts(block.text, userText)
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
