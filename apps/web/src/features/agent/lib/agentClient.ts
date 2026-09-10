import type {
  AgentActiveTurnView,
  AgentConversationView,
  AgentFrame,
  AgentMessageView,
} from '@image-playground/shared'
import { AGENT_FRAME_SEPARATOR, parseAgentFrame } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { getDeviceId } from '../../../lib/deviceId'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export class AgentRequestError extends Error {
  constructor(readonly status: number) {
    super(`Agent request failed with ${status}`)
    this.name = 'AgentRequestError'
  }
}

function url(path: string): string {
  return `${bffBaseUrl()}/api/agent${path}`
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function createConversation(
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationView> {
  const response = await fetcher(url('/conversations'), jsonInit({ deviceId: getDeviceId() }))
  if (!response.ok) throw new AgentRequestError(response.status)
  return ((await response.json()) as { conversation: AgentConversationView }).conversation
}

export interface AgentConversationState {
  readonly messages: AgentMessageView[]
  readonly activeTurn: AgentActiveTurnView | null
}

export async function fetchMessages(
  conversationId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationState> {
  const query = new URLSearchParams({ deviceId: getDeviceId() })
  const response = await fetcher(url(`/conversations/${conversationId}/messages?${query}`))
  if (!response.ok) throw new AgentRequestError(response.status)
  return (await response.json()) as AgentConversationState
}

async function* readFrames(response: Response): AsyncGenerator<AgentFrame> {
  if (!response.ok || !response.body) throw new AgentRequestError(response.status)
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

export async function* startTurn(
  conversationId: string,
  text: string,
  fetcher: Fetcher = authenticatedBffFetch,
): AsyncGenerator<AgentFrame> {
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns`),
    jsonInit({ deviceId: getDeviceId(), text }),
  )
  yield* readFrames(response)
}

/** `lastEventId` 为 0 表示从头要一遍这一轮：刷新后重新挂上走的就是这条。 */
export async function* resumeTurn(
  conversationId: string,
  turnId: string,
  lastEventId: number,
  fetcher: Fetcher = authenticatedBffFetch,
): AsyncGenerator<AgentFrame> {
  const query = new URLSearchParams({ deviceId: getDeviceId() })
  const headers = new Headers()
  if (lastEventId > 0) headers.set('last-event-id', String(lastEventId))
  const response = await fetcher(
    url(`/conversations/${conversationId}/turns/${turnId}/events?${query}`),
    { headers },
  )
  yield* readFrames(response)
}

export async function abortTurn(
  conversationId: string,
  turnId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<void> {
  await fetcher(
    url(`/conversations/${conversationId}/turns/${turnId}/abort`),
    jsonInit({ deviceId: getDeviceId() }),
  )
}

export async function interjectTurn(
  conversationId: string,
  turnId: string,
  text: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<void> {
  await fetcher(
    url(`/conversations/${conversationId}/turns/${turnId}/interject`),
    jsonInit({ deviceId: getDeviceId(), text }),
  )
}
