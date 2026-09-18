import type {
  AgentActiveTurnView,
  AgentBackgroundJobsResponse,
  AgentBackgroundJobView,
  AgentConversationView,
  AgentFrame,
  AgentMessageView,
  AgentMode,
  AgentSkillSummary,
  AgentTurnAlreadyRunningBody,
  AgentTurnEvent,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { AGENT_FRAME_SEPARATOR, DEVICE_ID_HEADER, parseAgentFrame } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { getDeviceId } from '../../../lib/deviceId'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

const CONTROL_REQUEST_TIMEOUT_MS = 15_000

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export class AgentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Agent request failed with ${status}`)
    this.name = 'AgentRequestError'
  }
}

async function requestError(response: Response): Promise<AgentRequestError> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new AgentRequestError(response.status, body?.error)
}

function url(path: string): string {
  return `${bffBaseUrl()}/api/agent${path}`
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/**
 * GET 端点的设备标识走请求头：它是纯 bearer，放 query string 会被抄进访问日志、
 * 代理日志和浏览器历史。POST 的设备标识在 body 里，同样不进 URL。
 */
function deviceHeaders(): Record<string, string> {
  return { [DEVICE_ID_HEADER]: getDeviceId() }
}

export async function createConversation(
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationView> {
  const response = await fetcher(url('/conversations'), jsonInit({ deviceId: getDeviceId() }))
  if (!response.ok) throw await requestError(response)
  return ((await response.json()) as { conversation: AgentConversationView }).conversation
}

export async function fetchConversations(
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationView[]> {
  const response = await fetcher(url('/conversations'), { headers: deviceHeaders() })
  if (!response.ok) throw await requestError(response)
  return ((await response.json()) as { conversations: AgentConversationView[] }).conversations
}

export async function removeConversation(
  conversationId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<void> {
  const response = await fetcher(
    url(`/conversations/${conversationId}`),
    jsonInit({ deviceId: getDeviceId() }, 'DELETE'),
  )
  if (!response.ok) throw await requestError(response)
}

export async function adoptAgentConversations(
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<number> {
  const response = await fetcher(url('/conversations/adopt'), jsonInit({ deviceId: getDeviceId() }))
  if (!response.ok) throw await requestError(response)
  return ((await response.json()) as { adopted: number }).adopted
}

/** 会话快照（见 `AgentConversationSnapshot`）。`cursor` 缺席说明是老服务端，只能按轮续播。 */
export interface AgentConversationState {
  readonly messages: AgentMessageView[]
  readonly turns: AgentTurnSummaryView[]
  readonly activeTurn: AgentActiveTurnView | null
  readonly cursor?: number
}

export async function fetchMessages(
  conversationId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationState> {
  const response = await fetcher(url(`/conversations/${conversationId}/messages`), {
    headers: deviceHeaders(),
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await requestError(response)
  return (await response.json()) as AgentConversationState
}
export async function fetchMessageReference(
  conversationId: string,
  messageId: string,
  index: number,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await authenticatedBffFetch(
    url(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/references/${index}`,
    ),
    { headers: deviceHeaders(), signal },
  )
  if (!response.ok) throw await requestError(response)
  return response.blob()
}

/** 这个会话提交过的后台任务，结果块是服务端此刻结算出的样子。 */
export async function fetchJobs(
  conversationId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<readonly AgentBackgroundJobView[]> {
  const response = await fetcher(url(`/conversations/${conversationId}/jobs`), {
    headers: deviceHeaders(),
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await requestError(response)
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs
}

async function* readFrames(response: Response): AsyncGenerator<AgentFrame> {
  if (!response.ok || !response.body) throw await requestError(response)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const drain = function* (flush: boolean) {
    const blocks = buffered.split(AGENT_FRAME_SEPARATOR)
    // 末段可能是半帧，留着等下一个 chunk；流结束时它是最后一帧，得交出去。
    buffered = flush ? '' : (blocks.pop() ?? '')
    for (const block of blocks) {
      const frame = parseAgentFrame(block)
      if (frame) yield frame
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    yield* drain(false)
  }
  yield* drain(true)
}

/**
 * 起轮的两种结局。`alreadyRunning` 是别的标签页正占着这个会话的轮：服务端在 409 里
 * 给出那一轮，调用方转去续播它，而不是把并发当失败。
 */
export type StartTurnOutcome =
  | { readonly kind: 'frames'; readonly frames: AsyncGenerator<AgentFrame> }
  | { readonly kind: 'alreadyRunning'; readonly turnId: string }

/** 409 没带轮标识时按普通失败处理：帧生成器会在第一次读取时抛 `AgentRequestError`。 */
async function alreadyRunningTurnId(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Partial<AgentTurnAlreadyRunningBody>
    return typeof body.turnId === 'string' && body.turnId ? body.turnId : null
  } catch {
    return null
  }
}

/**
 * 输入框打 `/` 时的候选。技能是部署的东西、不是用户的东西，所以按 mode 现拉一次就够，
 * 不进任何本地存储。
 */
export async function fetchAgentSkills(
  mode: AgentMode,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentSkillSummary[]> {
  const response = await fetcher(url(`/skills?mode=${mode}`), { headers: deviceHeaders() })
  if (!response.ok) throw await requestError(response)
  const body = (await response.json()) as { skills?: AgentSkillSummary[] }
  return body.skills ?? []
}

export async function startTurn(
  conversationId: string,
  text: string,
  references: readonly AgentTurnReference[] = [],
  params?: AgentTurnParams,
  mode?: AgentMode,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<StartTurnOutcome> {
  references = await resolveReferences(references)
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns`),
    jsonInit({
      deviceId: getDeviceId(),
      text,
      ...(references.length ? { references } : {}),
      // 图片是服务端的默认；只有视频才值得占一个字段，老服务端也认得出这是新东西。
      ...(mode && mode !== 'image' ? { mode } : {}),
      ...(params ? { params } : {}),
    }),
  )
  if (response.status === 409) {
    const turnId = await alreadyRunningTurnId(response)
    if (turnId) return { kind: 'alreadyRunning', turnId }
  }
  if (!response.ok || !response.body) throw await requestError(response)
  return { kind: 'frames', frames: readFrames(response) }
}

/** `lastEventId` 为 0 表示从头要一遍这一轮。 */
async function* resumeTurn(
  conversationId: string,
  turnId: string,
  lastEventId: number,
  fetcher: Fetcher = authenticatedBffFetch,
  onOpen?: () => void,
): AsyncGenerator<AgentFrame> {
  const headers = new Headers(deviceHeaders())
  if (lastEventId > 0) headers.set('last-event-id', String(lastEventId))
  const response = await fetcher(url(`/conversations/${conversationId}/turns/${turnId}/events`), {
    headers,
  })
  // 续播端点应了就算接上：长任务期间可能半天没有新帧，不能等下一帧才撤掉断线提示。
  if (response.ok && response.body) onOpen?.()
  yield* readFrames(response)
}

/** 会话级增量：`lastEventId` 之后这个会话的全部事件，不分哪一轮。 */
async function* resumeConversation(
  conversationId: string,
  lastEventId: number,
  fetcher: Fetcher = authenticatedBffFetch,
  onOpen?: () => void,
): AsyncGenerator<AgentFrame> {
  const headers = new Headers(deviceHeaders())
  if (lastEventId > 0) headers.set('last-event-id', String(lastEventId))
  const response = await fetcher(url(`/conversations/${conversationId}/events`), { headers })
  if (response.ok && response.body) onOpen?.()
  yield* readFrames(response)
}

/** 断了之后隔多久再续播。第一次立刻重试：多数断流是中间设备掐的，续播马上就接上了。 */
const RECONNECT_DELAYS_MS = [0, 500, 2_000, 5_000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 跟一轮到底之后这一轮是怎么收的场：读到终帧、这一轮不在了、被限流、一直接不上，
 * 或者调用方自己叫停。
 */
export type AgentTurnOutcome = 'ended' | 'gone' | 'rateLimited' | 'unreachable' | 'stopped'

/**
 * 从哪儿开始跟：起轮拿到的那条流，或者已知轮标识时续播。带着快照的 `cursor` 就从它之后接
 * 会话级增量；没有游标（老服务端）就把这一轮从头要一遍。
 */
export type AgentTurnSource =
  | { readonly frames: AsyncGenerator<AgentFrame> }
  | { readonly turnId: string; readonly cursor?: number }

export interface FollowTurnOptions {
  /** 叫停的唯一入口：转假之后不再重连、不再续播，流就此收束。 */
  readonly shouldContinue?: () => boolean
  /** 重连退避表，测试用来跳过等待。 */
  readonly delaysMs?: readonly number[]
  readonly fetcher?: Fetcher
  /** 流断了、正在续播时报 `true`，接上或就此收场时报 `false`；同一个值不重复报。 */
  readonly onReconnectingChange?: (reconnecting: boolean) => void
}

export interface AgentTurnStream {
  /** 已按帧标识去重、断了自己带断点重连的事件流。 */
  readonly events: AsyncGenerator<AgentTurnEvent>
  /** 流走完之后的终局；走完之前是 `null`。 */
  readonly outcome: AgentTurnOutcome | null
}

/**
 * 跟一轮到底：流断了就带 `Last-Event-ID` 续播，重发与重放的帧按帧标识丢掉，直到读到终帧
 * 或者一直接不上。调用方只看事件与终局，不必知道断点、帧标识与退避表。
 */
export function followTurn(
  conversationId: string,
  source: AgentTurnSource,
  {
    shouldContinue = () => true,
    delaysMs = RECONNECT_DELAYS_MS,
    fetcher = authenticatedBffFetch,
    onReconnectingChange,
  }: FollowTurnOptions = {},
): AgentTurnStream {
  let outcome: AgentTurnOutcome | null = null
  let reconnecting = false
  const setReconnecting = (value: boolean) => {
    if (reconnecting === value) return
    reconnecting = value
    onReconnectingChange?.(value)
  }
  const connected = () => setReconnecting(false)
  async function* follow(): AsyncGenerator<AgentTurnEvent> {
    // 续播要有轮标识：起轮那条流得先从 `turnStart` 里学到它。
    let turnId = 'turnId' in source ? source.turnId : ''
    const cursor = 'turnId' in source ? source.cursor : undefined
    // 帧标识是会话内序号，按会话接和按轮接用的是同一个断点。
    const resume = (after: number) =>
      cursor === undefined
        ? resumeTurn(conversationId, turnId, after, fetcher, connected)
        : resumeConversation(conversationId, after, fetcher, connected)
    // 见过的最大帧标识，就是续播的断点；快照已经覆盖到游标为止。
    let seen = cursor ?? 0
    let frames = 'frames' in source ? source.frames : resume(seen)
    // 流里最近一个 `turnStart` 属于哪一轮；它之后、下一个 `turnStart` 之前的事件都归它。
    // 续播从一轮中间接上时还没见过 `turnStart`，那段就是这一轮自己的。
    let owner = turnId
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!shouldContinue()) return
        try {
          for await (const frame of frames) {
            if (!shouldContinue()) return
            if (frame.id !== null && frame.id <= seen) continue
            if (frame.id !== null) {
              seen = frame.id
              // 有进展就说明这次连接是好的，退避从头算。
              attempt = -1
            }
            if (frame.event.type === 'turnStart') {
              if (!turnId) turnId = frame.event.turnId
              owner = frame.event.turnId
            }
            // 会话级增量里夹着别的轮：它的事件不是这一轮的内容，终帧也不是这一轮的结局，
            // 交出去只会把别处的回复画进这个面板、或者把面板提前收成空闲。
            if (owner !== turnId) continue
            if (frame.event.type === 'turnEnd' && frame.event.turnId !== turnId) continue
            yield frame.event
            if (frame.event.type === 'turnEnd') {
              outcome = 'ended'
              return
            }
          }
        } catch (thrown) {
          if (!shouldContinue()) return
          if (thrown instanceof AgentRequestError && thrown.status === 404) {
            outcome = 'gone'
            return
          }
          if (thrown instanceof AgentRequestError && thrown.status === 429) {
            outcome = 'rateLimited'
            return
          }
          // 其余都当断流：接着往下重连。
        }
        const delay = delaysMs[Math.max(attempt, 0)]
        // 轮标识还没学到就没有轮可以接；退避表用尽同理。
        if (!turnId || delay === undefined) {
          outcome = 'unreachable'
          return
        }
        setReconnecting(true)
        await sleep(delay)
        if (!shouldContinue()) return
        frames = resume(seen)
      }
    } finally {
      // 叫停与调用方自己走掉（break / return）都收在这里。
      outcome ??= 'stopped'
      setReconnecting(false)
    }
  }
  return {
    events: follow(),
    get outcome() {
      return outcome
    },
  }
}

export async function abortTurn(
  conversationId: string,
  turnId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<void> {
  const response = await fetcher(url(`/conversations/${conversationId}/turns/${turnId}/abort`), {
    ...jsonInit({ deviceId: getDeviceId() }),
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await requestError(response)
}

export async function interjectTurn(
  conversationId: string,
  turnId: string,
  text: string,
  references: readonly AgentTurnReference[] = [],
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<string> {
  references = await resolveReferences(references)
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns/${turnId}/interject`),
    jsonInit({ deviceId: getDeviceId(), text, references }),
  )
  if (!response.ok) throw await requestError(response)
  return ((await response.json()) as { messageId: string }).messageId
}

async function resolveReferences(
  references: readonly AgentTurnReference[],
): Promise<AgentTurnReference[]> {
  const resolved: AgentTurnReference[] = []
  for (const reference of references)
    resolved.push({ ...reference, dataUrl: await resolveMediaSource(reference.dataUrl) })
  return resolved
}
