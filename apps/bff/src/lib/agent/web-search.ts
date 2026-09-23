import { config } from '../../config'
import type { ChatAttempt } from '../chatCompletion'
import { resolveApiKey } from '../resolveApiKey'
import {
  createDispatcher,
  createFetchSlot,
  startDeadline,
  type UndiciFetchInit,
  type UndiciFetchInput,
} from '../timeoutFetch'
import { isObject } from '../type-guards'

/**
 * 搜索走网关的 **Responses API 自带的 `web_search` 工具**，不是我们自己爬搜索引擎：
 * 检索、读页、挑结果全在上游一次调用里完成，回来的是一段带引用标注的文字。
 *
 * 它与 `chatCompletion.ts` 是两个端点、两套响应形状，所以自己一份：那边读
 * `choices[].message.content`，这边读 `output[]` 里的 `message` 块及其 `annotations`。
 * 共用的只有超时预算与测试接缝的写法。
 *
 * 2026-09-23 在生产网关上实测：`output[]` 依次是 `reasoning`、`web_search_call`、`message`，
 * 单次 11~14 秒，输入约 8.8k token（网关自己往里塞了上下文），所以超时给到 45 秒。
 */

/** 给模型的角色说明。越短越好：它每次搜索都随请求发出去。 */
const INSTRUCTIONS =
  'You are a web search helper. Use the web_search tool, then list the results as a markdown list. Each item: the page title in bold, its URL, and one line describing what it says. No preamble, no conclusion.'

/** 实测单次 11~14 秒；45 秒是它的三倍出头，留给上游抖动，又不至于把一轮拖到用户放弃。 */
const AGENT_WEB_SEARCH_TIMEOUT_MS = 45_000

/** 一条结果的说明取被引用的那一段原文，超出就截断——它是给模型看的摘要，不是正文。 */
const DESCRIPTION_MAX_CHARS = 280

/** 上游出错时偶尔回一整页 HTML；截一段够运维认出是什么就行。 */
const UPSTREAM_DETAIL_CHARS = 500

const CONNECT_TIMEOUT_MS = 10_000

const searchDispatcher = createDispatcher({ connectMs: CONNECT_TIMEOUT_MS })

interface SearchResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

type SearchFetch = (input: UndiciFetchInput, init?: UndiciFetchInit) => Promise<SearchResponse>

const searchTransport = createFetchSlot<SearchFetch>()

/** 测试注入点；不传即恢复真实 transport。 */
export function setAgentSearchFetchForTesting(fetchImpl?: SearchFetch): void {
  searchTransport.set(fetchImpl)
}

/**
 * 搜索这一次没成的三种结局。分开是因为出路不同：上游故障与超时原样再来一次有望成功，
 * 响应读不出结果则再试多少次都一样。
 */
export class AgentWebSearchError extends Error {
  constructor(
    readonly reason: 'upstream' | 'timeout' | 'unusable',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWebSearchError'
  }
}

/**
 * 一条搜索结果。比面板要的 {@link AgentWebSource} 多一句说明：那句只进这一轮交给模型的
 * 正文，不进结果块——回放时正文早已用过，留着网址就够模型决定要不要再抓一次。
 */
export interface AgentWebSearchHit {
  readonly title: string
  readonly url: string
  readonly description: string
}

export interface AgentWebSearchInput {
  readonly query: string
  readonly count: number
  /** 这一轮被中止时跟着停；搜索是这一轮里用户实打实等着的那十几秒。 */
  readonly signal?: AbortSignal
  /** 每次真实请求各报告一次，成败都报——收到响应的那一刻钱已经花了。 */
  readonly onAttempt?: (attempt: ChatAttempt) => Promise<void>
}

export interface AgentWebSearchOutcome {
  /** 模型写的那段 markdown 列表。结果的说明从它里面切。 */
  readonly text: string
  readonly hits: readonly AgentWebSearchHit[]
}

function requestBody({ query, count }: AgentWebSearchInput): string {
  return JSON.stringify({
    model: config.agent.searchModel,
    instructions: INSTRUCTIONS,
    // 搜索要的是检索与转述，不是推演；低档位省掉大半输出 token 与一半等待。
    reasoning: { effort: 'low' },
    tools: [{ type: 'web_search' }],
    input: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL and a one-line description.`,
    stream: false,
  })
}

/**
 * Responses 的响应体，逐层现查。**不写 `as { output: ... }`**：这份 JSON 来自网络，
 * 断言只是把「没检查」写得像检查过，形状一变就在某个 `.map` 里炸成看不懂的 TypeError。
 */
function parseOutcome(raw: string): AgentWebSearchOutcome | null {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(payload) || !Array.isArray(payload.output)) return null
  const texts: string[] = []
  const hits: AgentWebSearchHit[] = []
  const seen = new Set<string>()
  for (const item of payload.output) {
    // `reasoning` 与 `web_search_call` 也在这个数组里，它们没有正文，跳过。
    if (!isObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isObject(part) || typeof part.text !== 'string') continue
      const text = part.text
      texts.push(text)
      if (!Array.isArray(part.annotations)) continue
      for (const annotation of part.annotations) {
        if (!isObject(annotation) || annotation.type !== 'url_citation') continue
        const { title, start_index: start } = annotation
        const url = typeof annotation.url === 'string' ? withoutTracking(annotation.url) : ''
        if (!url || seen.has(url)) continue
        seen.add(url)
        const named = typeof title === 'string' && title.trim() ? title.trim() : url
        hits.push({
          title: named,
          url,
          description: typeof start === 'number' ? citedLine(text, start, named) : '',
        })
      }
    }
  }
  // 一条来源都没有、正文也是空的，就是这次搜索什么也没搜到，按读不出结果处理。
  if (texts.length === 0 && hits.length === 0) return null
  return { text: texts.join('\n').trim(), hits }
}

/**
 * 一条结果在说什么。标注本身圈住的只是行尾那个「([站点](网址))」引用链接，真正的说明是
 * 它前面那一行：取那一行，去掉加粗、网址与重复的标题，剩下的就是上游替这条结果写的那句话。
 * 标注越界或那一行什么也不剩时留空，不编。
 */
function citedLine(text: string, start: number, title: string): string {
  if (start <= 0 || start > text.length) return ''
  const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start)
  return line
    .replace(/\*\*/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(title, '')
    .replace(/^[\s\-*\d.]+/, '')
    .replace(/^[\s—–:|-]+|[\s—–:|(-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS)
}

/** 上游给每条引用都挂了 `utm_source=openai`；它对模型没意义，还让同一页因参数不同而去不了重。 */
function withoutTracking(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.searchParams.get('utm_source') !== 'openai') return raw
    url.searchParams.delete('utm_source')
    return url.href
  } catch {
    return raw
  }
}

/** 这次调用花了多少。Responses 的字段名与 chat/completions 不同，两处各读各的。 */
function responseUsage(raw: string): ChatAttempt['usage'] {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(payload) || !isObject(payload.usage)) return null
  const { input_tokens: input, output_tokens: output } = payload.usage
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return null
  return { inputTokens: input, outputTokens: output }
}

/**
 * 一次搜索 = 一次上游调用，不重试：它已经是这一轮里最慢的一步，再来一次是让用户多等十几秒
 * 换一份未必更好的结果。失败就把原因交回模型，它可以换个问法，也可以不搜直接做。
 */
export async function searchWeb(input: AgentWebSearchInput): Promise<AgentWebSearchOutcome> {
  const id = crypto.randomUUID()
  const startedAt = Date.now()
  const model = config.agent.searchModel
  let usage: ChatAttempt['usage'] = null
  let status: ChatAttempt['status'] = 'failed'
  const deadline = startDeadline(AGENT_WEB_SEARCH_TIMEOUT_MS, input.signal)
  try {
    const response = await searchTransport.current(`${config.upstream.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveApiKey('openai-compat')}`,
      },
      body: requestBody(input),
      signal: deadline.signal,
      dispatcher: searchDispatcher,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new AgentWebSearchError(
        'upstream',
        `搜索服务返回 HTTP ${response.status}${detail ? `：${detail.slice(0, UPSTREAM_DETAIL_CHARS)}` : ''}`,
      )
    }
    const raw = await response.text()
    usage = responseUsage(raw)
    // 收到了响应，这次调用的钱已经花了：记成 completed，哪怕正文读不出结果。
    status = 'completed'
    const outcome = parseOutcome(raw)
    if (!outcome) throw new AgentWebSearchError('unusable', '搜索服务没有返回可用的结果')
    return outcome
  } catch (error) {
    // 只有我们自己切的才算超时；外部中止与上游主动断开保持原样往上抛。
    if (deadline.timedOut && !input.signal?.aborted) {
      const seconds = AGENT_WEB_SEARCH_TIMEOUT_MS / 1000
      throw new AgentWebSearchError('timeout', `搜索超过 ${seconds} 秒没有返回`)
    }
    throw error
  } finally {
    deadline.release()
    await input.onAttempt?.({ id, model, startedAt, finishedAt: Date.now(), status, usage })
  }
}
