import { type AssistantMessage, isRetryableAssistantError } from '@earendil-works/pi-ai'
import { config } from '../config'
import { AgentRequestBudgetError, assertOutboundBody } from './agent/outbound-budget'
import { log } from './logger'
import { resolveChatApiKey } from './resolveApiKey'
import {
  createDispatcher,
  createFetchSlot,
  startDeadline,
  type UndiciFetchInit,
  type UndiciFetchInput,
} from './timeoutFetch'
import { isObject } from './type-guards'

// 独立于 upstream.ts：那里是生图队列的协议适配，超时预算按分钟算，这里按秒。

export class ChatUpstreamError extends Error {
  constructor(
    readonly status: number,
    /** 错误体的开头一段：429 既可能是限流也可能是配额烧光，两者只差响应体里的那几个字。 */
    readonly detail = '',
  ) {
    super(`Chat upstream returned ${status}${detail ? `: ${detail}` : ''}`)
    this.name = 'ChatUpstreamError'
  }
}

export class ChatInvalidResponseError extends Error {
  constructor() {
    super('Chat model did not return a usable answer')
    this.name = 'ChatInvalidResponseError'
  }
}

/** 模型答得太慢，不是它答不了。调用方据此提示重试，而不是报告上游故障。 */
export class ChatTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Chat upstream did not answer within ${timeoutMs}ms`)
    this.name = 'ChatTimeoutError'
  }
}

interface ChatResponse {
  readonly ok: boolean
  readonly status: number
  /** Real fetch responses expose headers; legacy test transports may omit them. */
  readonly headers?: Pick<Headers, 'get'>
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

export interface ChatAttempt {
  readonly id: string
  readonly model: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: 'completed' | 'failed'
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cachedInputTokens?: number
  } | null
  readonly httpDispatchCount?: 0 | 1
  readonly requestBytes?: number | null
  readonly upstreamRequestId?: string
  readonly upstreamStatus?: number
  readonly localRejection?: AgentRequestBudgetError
}

export interface ChatAsk {
  readonly model: string
  readonly prompt: string
  readonly images?: readonly string[]
  readonly maxTokens: number
  readonly timeoutMs: number
  /** 每次尝试各报告一次；本地拒绝显式标记零派发与零用量，不包含请求正文。 */
  readonly onAttempt?: (attempt: ChatAttempt) => Promise<void>
}

/** One independently accounted call; retrying requires a new explicitly authorized task. */
export interface ChatOnceAsk extends ChatAsk {
  readonly attemptId: string
  readonly signal?: AbortSignal
  readonly beforeDispatch?: (intent: {
    readonly id: string
    readonly requestBytes: number
    readonly signal: AbortSignal
  }) => Promise<void>
}

/** Shares serialization and transport with chat while deliberately skipping its retry policy. */
export function askChatModelOnce(ask: ChatOnceAsk): Promise<string | undefined> {
  return requestContent(requestBody(ask), ask, ask)
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

function responseUsage(raw: string): ChatAttempt['usage'] {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(payload) || !isObject(payload.usage)) return null
  const { prompt_tokens: input, completion_tokens: output } = payload.usage
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return null
  const details = payload.usage.prompt_tokens_details
  const cached = isObject(details) ? details.cached_tokens : undefined
  if (
    cached !== undefined &&
    (typeof cached !== 'number' || !Number.isSafeInteger(cached) || cached < 0 || cached > input)
  )
    return null
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
  }
}

/** 上游出错时偶尔回一整页 HTML，而重试分类器只看模式：截一段够它匹配就行。 */
const UPSTREAM_DETAIL_CHARS = 500

async function requestContent(
  body: string,
  ask: ChatAsk,
  once?: ChatOnceAsk,
): Promise<string | undefined> {
  const id = once?.attemptId ?? crypto.randomUUID()
  const startedAt = Date.now()
  let requestBytes: number | null | undefined
  let localRejection: AgentRequestBudgetError | undefined
  let usage: ChatAttempt['usage'] = null
  let status: ChatAttempt['status'] = 'failed'
  let dispatched = false
  let upstreamRequestId: string | undefined
  let upstreamStatus: number | undefined
  const deadline = startDeadline(ask.timeoutMs, once?.signal)
  try {
    deadline.signal.throwIfAborted()
    try {
      requestBytes = assertOutboundBody(body, config.operator.quotas['agent:request-max-bytes'])
    } catch (error) {
      if (error instanceof AgentRequestBudgetError) {
        localRejection = error
        requestBytes = error.requestBytes
      }
      throw error
    }
    if (once?.beforeDispatch) {
      const beforeDispatch = once.beforeDispatch
      const bytes = requestBytes
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(deadline.signal.reason)
        deadline.signal.addEventListener('abort', aborted, { once: true })
        if (deadline.signal.aborted) aborted()
        else
          void beforeDispatch({ id, requestBytes: bytes, signal: deadline.signal })
            .then(resolve, reject)
            .finally(() => deadline.signal.removeEventListener('abort', aborted))
      })
    }
    // Cancellation may win while the durable intent is being written; report a known zero below.
    deadline.signal.throwIfAborted()
    dispatched = true
    const response = await chatTransport.current(`${config.upstream.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveChatApiKey(ask.model)}`,
      },
      body,
      signal: deadline.signal,
      dispatcher: chatDispatcher,
    })
    upstreamStatus = response.status
    upstreamRequestId =
      response.headers?.get('x-request-id') ?? response.headers?.get('request-id') ?? undefined
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new ChatUpstreamError(response.status, detail.slice(0, UPSTREAM_DETAIL_CHARS))
    }
    const raw = await response.text()
    usage = responseUsage(raw)
    status = 'completed'
    return messageContent(raw)
  } catch (error) {
    // 只有我们自己切的才算超时；上游主动断开保持原样往上抛。
    if (deadline.timedOut) throw new ChatTimeoutError(ask.timeoutMs)
    throw error
  } finally {
    deadline.release()
    await ask.onAttempt?.({
      id,
      model: ask.model,
      startedAt,
      finishedAt: Date.now(),
      status,
      usage: dispatched ? usage : { inputTokens: 0, outputTokens: 0 },
      httpDispatchCount: dispatched ? 1 : 0,
      ...(requestBytes !== undefined ? { requestBytes } : {}),
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      ...(localRejection ? { localRejection } : {}),
    })
  }
}

/** 内容不可用（模型答了，但答的不是我们要的 JSON）只再问一次：措辞歪了不会因为多等而变对。 */
const MAX_CONTENT_RETRIES = 1

/** 瞬时故障（502 / 限流 / 连接被掐）重试两次就够翻过一次限流窗口，再多是拿压缩的时长赌。 */
const MAX_TRANSIENT_RETRIES = 2

/**
 * 两种重试共用的总请求上限。少了它两层重试会相乘——上游每次先 502、答上来又答歪，
 * 一次摘要就能发出四次请求。
 */
const MAX_CHAT_ATTEMPTS = 1 + MAX_TRANSIENT_RETRIES

/** 失败第 n 次后等 `base * 2^(n-1)`：500ms、1000ms。 */
const RETRY_BACKOFF_BASE_MS = 500

let retryBackoffBaseMs = RETRY_BACKOFF_BASE_MS

/** 只为测试存在：真退避一轮要花 1.5 秒，测试没必要拿墙钟换这点确定性，传 0 即可。 */
export function setChatRetryBackoffForTesting(baseMs?: number): void {
  retryBackoffBaseMs = baseMs ?? RETRY_BACKOFF_BASE_MS
}

/** pi 的 `AssistantMessage` 要求 usage 齐全，而分类器一个数字都不读；补零是形状税。 */
const CLASSIFIER_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * 借 pi 的 `isRetryableAssistantError` 判断这次失败值不值得再试。它认的是一整套上游文案：
 * `insufficient_quota` / `Monthly usage limit reached` 这类账单耗尽要立刻放弃（重试只是
 * 重复撞墙），`502` / `overloaded` / `socket hang up` 这类才是瞬时故障。这份清单跟着各家
 * 上游的措辞漂移，自己在本仓库养一份不划算——所以把错误折成一条最小的 assistant 消息喂给它。
 */
function isTransientChatError(error: unknown, model: string): boolean {
  // 超时是我们自己切的 deadline，不是上游的毛病：重试只会把这一轮的总耗时翻倍。
  if (error instanceof ChatTimeoutError || error instanceof AgentRequestBudgetError) return false
  const failed: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openai-compat',
    model,
    usage: CLASSIFIER_USAGE,
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
  return isRetryableAssistantError(failed)
}

/**
 * 一个循环收两种毛病：模型答成了但内容不可用，以及上游根本没答成。两者的预算分开记
 * （前者重试无益，后者值得退避），总请求数共用 `MAX_CHAT_ATTEMPTS` 一个上限。
 *
 * 只借 pi 的分类器，不借它的 `retryAssistantCall`：那个循环围绕「produce 返回
 * AssistantMessage」设计，而这里返回的是解析后的 JSON、失败靠抛异常，套进去要把异常折成
 * 消息、再把消息折回异常，适配代码比重试循环本身还长。
 */
export async function askChatModel<T>(
  ask: ChatAsk,
  parse: (value: unknown) => T | null,
): Promise<T> {
  // 请求体只序列化一次：参考图是 data URL，重试时重新转义要多花一整份内存。
  const body = requestBody(ask)
  let contentRetries = 0
  let transientRetries = 0
  for (let attempt = 1; ; attempt += 1) {
    let content: string | undefined
    try {
      content = await requestContent(body, ask)
    } catch (error) {
      if (
        attempt >= MAX_CHAT_ATTEMPTS ||
        transientRetries >= MAX_TRANSIENT_RETRIES ||
        !isTransientChatError(error, ask.model)
      ) {
        throw error
      }
      transientRetries += 1
      const delayMs = retryBackoffBaseMs * 2 ** (attempt - 1)
      log.warn(
        { event: 'agent.chat_retry', attempt, delayMs, reason: 'upstream failure', err: error },
        'chat request retried',
      )
      // 退避就地写：为一个 setTimeout 引第三方不值当。
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, delayMs)
      await promise
      continue
    }
    const parsed = content === undefined ? null : parse(extractJson(content))
    if (parsed) return parsed
    if (attempt >= MAX_CHAT_ATTEMPTS || contentRetries >= MAX_CONTENT_RETRIES) {
      throw new ChatInvalidResponseError()
    }
    contentRetries += 1
    // 上游是好的，只是这次答歪了：立刻再问一次，等待救不了措辞。
    log.warn(
      { event: 'agent.chat_retry', attempt, delayMs: 0, reason: 'unusable answer' },
      'chat request retried',
    )
  }
}
