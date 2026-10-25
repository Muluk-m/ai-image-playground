import { createParser } from 'eventsource-parser'
import { log } from '../logger'
import type { AgentFetch } from './model'
import { AGENT_SSE_LINE_MAX_CHARS } from './stream-tool-arguments'
import { estimateTextTokenMilli } from './token-estimate'

/** 估算口径与上游分词器不同，越过预算这么多倍才收尾，写满预算的合法回复不受影响。 */
export const AGENT_OUTPUT_LIMIT_MARGIN = 1.25
/** 只看最近这么多字符：其中最小周期不超过 REPETITION_MAX_PERIOD，即同一段内容连续重复了至少 16 次。 */
export const REPETITION_WINDOW_CHARS = 4096
const REPETITION_MAX_PERIOD = 256
const REPETITION_CHECK_EVERY_CHARS = 512

/** 和 pi 一样只认第一个非空的推理字段：有的网关同一段推理会放两个字段。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const

export class AgentOutputRepetitionError extends Error {
  constructor(readonly period: number) {
    super(`Model output degenerated into a loop repeating every ${period} characters`)
    this.name = 'AgentOutputRepetitionError'
  }
}

interface OutputDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  reasoning_text?: unknown
  tool_calls?: Array<{ function?: { arguments?: unknown }; custom?: { input?: unknown } }>
}

function deltaTexts(delta: OutputDelta): string[] {
  const texts: string[] = []
  if (typeof delta.content === 'string') texts.push(delta.content)
  const reasoning = REASONING_FIELDS.map((field) => delta[field]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (reasoning) texts.push(reasoning)
  if (Array.isArray(delta.tool_calls))
    for (const call of delta.tool_calls) {
      const piece = call?.function?.arguments ?? call?.custom?.input
      if (typeof piece === 'string') texts.push(piece)
    }
  return texts
}

/** 整段文本的最小周期（KMP 失配函数），线性时间。 */
export function smallestPeriod(text: string): number {
  const fail = new Int32Array(text.length)
  for (let i = 1, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== text[k]) k = fail[k - 1]!
    if (text[i] === text[k]) k++
    fail[i] = k
  }
  return text.length - (text.length ? fail[text.length - 1]! : 0)
}

/** 累计最近输出，判断末尾是否陷入短周期循环。 */
export class RepetitionDetector {
  private tail = ''
  private sinceCheck = 0

  /** 陷入循环时返回周期长度，否则返回 0。 */
  push(text: string): number {
    this.tail += text
    if (this.tail.length > REPETITION_WINDOW_CHARS * 2)
      this.tail = this.tail.slice(-REPETITION_WINDOW_CHARS)
    this.sinceCheck += text.length
    if (
      this.sinceCheck < REPETITION_CHECK_EVERY_CHARS ||
      this.tail.length < REPETITION_WINDOW_CHARS
    )
      return 0
    this.sinceCheck = 0
    const period = smallestPeriod(this.tail.slice(-REPETITION_WINDOW_CHARS))
    return period <= REPETITION_MAX_PERIOD ? period : 0
  }
}

const sse = (data: string, event?: string) =>
  `${event ? `event: ${event}\n` : ''}${data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`

/**
 * 在客户端执行模型输出预算，并识别退化循环。网关 sub2api 不执行任何输出上限（2026-10-24 实测
 * max_tokens / max_completion_tokens / max_output_tokens 设 30 都照样吐 4000+ token），
 * 一次调用曾连续吐了 10 分钟工具参数。
 *
 * - 超出预算：补一个 `finish_reason: "length"` 收尾并取消上游，后面与网关真的截断时完全一样，
 *   走既有的截断续写。
 * - 陷入循环：直接报错，不续写——续写多半再转进同一个圈。
 *
 * 只转发完整的 SSE 事件，收尾时下游不会拿到半截事件。
 */
export function withOutputLimit(fetchFn: AgentFetch, maxTokens: number): AgentFetch {
  const limitMilli = Math.ceil(maxTokens * AGENT_OUTPUT_LIMIT_MARGIN) * 1000
  return async (input, init) => {
    const response = await fetchFn(input, init)
    if (!response.body || !response.ok) return response
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const repetition = new RepetitionDetector()
    let usedMilli = 0
    let responseId: string | undefined
    let capped = false
    let output: TransformStreamDefaultController<Uint8Array>
    const parser = createParser({
      maxBufferSize: AGENT_SSE_LINE_MAX_CHARS,
      // 超长单行由工具参数那一层报错，这里只管输出预算。
      onError() {},
      onEvent(event) {
        if (capped) return
        let chunk: { id?: string; choices?: Array<{ delta?: OutputDelta }> } | undefined
        if (!event.data.startsWith('[DONE]'))
          try {
            chunk = JSON.parse(event.data)
          } catch {}
        responseId ??= chunk?.id
        if (Array.isArray(chunk?.choices))
          for (const choice of chunk.choices)
            for (const text of choice?.delta ? deltaTexts(choice.delta) : []) {
              usedMilli += estimateTextTokenMilli(text)
              const period = repetition.push(text)
              if (period) {
                log.warn(
                  { event: 'agent.output_repetition', period },
                  'model output degenerated into a loop',
                )
                throw new AgentOutputRepetitionError(period)
              }
            }
        if (usedMilli > limitMilli) {
          capped = true
          log.warn({ event: 'agent.output_capped', maxTokens }, 'model output ran past its budget')
          const finish = { index: 0, delta: {}, finish_reason: 'length' }
          output.enqueue(encoder.encode(sse(JSON.stringify({ id: responseId, choices: [finish] }))))
          output.enqueue(encoder.encode(sse('[DONE]')))
          output.terminate()
          return
        }
        output.enqueue(encoder.encode(sse(event.data, event.event)))
      },
    })
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          output = controller
          if (!capped) parser.feed(decoder.decode(chunk, { stream: true }))
        },
        flush(controller) {
          output = controller
          if (!capped) parser.feed(decoder.decode())
        },
      }),
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
