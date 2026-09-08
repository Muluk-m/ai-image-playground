import { config } from '../config'
import { resolveApiKey } from './resolveApiKey'
import {
  createDispatcher,
  createFetchSlot,
  type UndiciFetchInit,
  type UndiciFetchInput,
  withDeadline,
} from './timeoutFetch'
import { isObject } from './type-guards'

// 独立于 upstream.ts：那里是生图队列的协议适配，超时预算按分钟算，这里按秒。

export class ChatUpstreamError extends Error {
  constructor(readonly status: number) {
    super(`Chat upstream returned ${status}`)
    this.name = 'ChatUpstreamError'
  }
}

export class ChatInvalidResponseError extends Error {
  constructor() {
    super('Chat model did not return a usable answer')
    this.name = 'ChatInvalidResponseError'
  }
}

/** 两个失败都是 502：上游挂了与答非所问对调用方是一回事。返回 null 表示不是 chat 失败。 */
export function chatFailure(error: unknown, feature: string): Record<string, unknown> | null {
  if (error instanceof ChatUpstreamError) {
    return { error: `${feature}_upstream_error`, upstream_status: error.status }
  }
  if (error instanceof ChatInvalidResponseError) return { error: `${feature}_invalid_response` }
  return null
}

interface ChatResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

type ChatFetch = (input: UndiciFetchInput, init?: UndiciFetchInit) => Promise<ChatResponse>

const CONNECT_TIMEOUT_MS = 10_000
const POOL_TIMEOUT_MS = 90_000

const chatDispatcher = createDispatcher({
  connectMs: CONNECT_TIMEOUT_MS,
  transportMs: POOL_TIMEOUT_MS,
})

const chatTransport = createFetchSlot<ChatFetch>()

export function setChatFetchForTesting(fetchImpl?: ChatFetch): void {
  chatTransport.set(fetchImpl)
}

/** 上游回的 chat 文本，形状不对时 undefined —— 交给调用方决定重试还是放弃。 */
export function messageContent(raw: string): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(payload) || !Array.isArray(payload.choices)) return undefined
  const message = isObject(payload.choices[0]) ? payload.choices[0].message : undefined
  if (!isObject(message) || typeof message.content !== 'string') return undefined
  return message.content
}

/** 模型爱把 JSON 包在 ``` 里，也爱在前后加一句话，所以取最外层的那对花括号。 */
export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? content).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export interface ChatAsk {
  readonly model: string
  readonly prompt: string
  readonly images?: readonly string[]
  readonly maxTokens: number
  readonly timeoutMs: number
}

function requestBody({ model, prompt, images = [], maxTokens }: ChatAsk): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
  })
}

function requestContent(body: string, timeoutMs: number): Promise<string | undefined> {
  return withDeadline(timeoutMs, async (signal) => {
    const response = await chatTransport.current(`${config.upstream.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveApiKey('openai-compat')}`,
      },
      body,
      signal,
      dispatcher: chatDispatcher,
    })
    if (!response.ok) throw new ChatUpstreamError(response.status)
    return messageContent(await response.text())
  })
}

/** 上游偶发不回 JSON，重试一次；第二次仍不可用就是硬失败。 */
export async function askChatModel<T>(
  ask: ChatAsk,
  parse: (value: unknown) => T | null,
): Promise<T> {
  // 请求体只序列化一次：参考图是 data URL，重试时重新转义要多花一整份内存。
  const body = requestBody(ask)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestContent(body, ask.timeoutMs)
    const parsed = content === undefined ? null : parse(extractJson(content))
    if (parsed) return parsed
  }
  throw new ChatInvalidResponseError()
}
