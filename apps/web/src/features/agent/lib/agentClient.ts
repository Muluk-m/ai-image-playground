import type {
  AgentConversationView,
  AgentMessageView,
  AgentTurnEvent,
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

export async function createConversation(
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentConversationView> {
  const response = await fetcher(url('/conversations'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: getDeviceId() }),
  })
  if (!response.ok) throw new AgentRequestError(response.status)
  return ((await response.json()) as { conversation: AgentConversationView }).conversation
}

export async function fetchMessages(
  conversationId: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<AgentMessageView[]> {
  const query = new URLSearchParams({ deviceId: getDeviceId() })
  const response = await fetcher(url(`/conversations/${conversationId}/messages?${query}`))
  if (!response.ok) throw new AgentRequestError(response.status)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

export async function* streamTurn(
  conversationId: string,
  text: string,
  fetcher: Fetcher = authenticatedBffFetch,
): AsyncGenerator<AgentTurnEvent> {
  const response = await fetcher(url(`/conversations/${conversationId}/turns`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: getDeviceId(), text }),
  })
  if (!response.ok || !response.body) throw new AgentRequestError(response.status)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const drain = function* (flush: boolean) {
    const blocks = buffered.split(AGENT_FRAME_SEPARATOR)
    // 末段可能是半帧，留着等下一个 chunk；流结束时它是最后一帧，得交出去。
    buffered = flush ? '' : (blocks.pop() ?? '')
    for (const block of blocks) {
      const event = parseAgentFrame(block)
      if (event) yield event
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
