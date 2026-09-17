import type {
  AgentActiveTurnView,
  AgentConversationView,
  AgentFrame,
  AgentMessageView,
  AgentToolArtifact,
  AgentTurnAlreadyRunningBody,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { AGENT_FRAME_SEPARATOR, DEVICE_ID_HEADER, parseAgentFrame } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { fetchImageDataUrl, queueOutputUrl } from '../../../lib/channels/queueClient'
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

export interface AgentConversationState {
  readonly messages: AgentMessageView[]
  readonly turns: AgentTurnSummaryView[]
  readonly activeTurn: AgentActiveTurnView | null
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

export async function startTurn(
  conversationId: string,
  text: string,
  references: readonly AgentTurnReference[] = [],
  params?: AgentTurnParams,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<StartTurnOutcome> {
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns`),
    jsonInit({
      deviceId: getDeviceId(),
      text,
      ...(references.length ? { references } : {}),
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
export async function* resumeTurn(
  conversationId: string,
  turnId: string,
  lastEventId: number,
  fetcher: Fetcher = authenticatedBffFetch,
): AsyncGenerator<AgentFrame> {
  const headers = new Headers(deviceHeaders())
  if (lastEventId > 0) headers.set('last-event-id', String(lastEventId))
  const response = await fetcher(url(`/conversations/${conversationId}/turns/${turnId}/events`), {
    headers,
  })
  yield* readFrames(response)
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
): Promise<void> {
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns/${turnId}/interject`),
    jsonInit({ deviceId: getDeviceId(), text, references }),
  )
  if (!response.ok) throw await requestError(response)
}

export function fetchToolImage(artifact: AgentToolArtifact): Promise<string> {
  return fetchImageDataUrl(bffBaseUrl(), artifact.taskId, artifact.outputIndex, artifact.mime)
}

/** 视频产物的播放地址。mp4 不落本地，画布与结果卡都打这里。 */
export function toolArtifactUrl(artifact: AgentToolArtifact): string {
  return queueOutputUrl(artifact.taskId, artifact.outputIndex)
}
