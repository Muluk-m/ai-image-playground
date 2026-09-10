import type {
  AgentConversationView,
  AgentMessageView,
  AgentTurnEvent,
} from '@image-playground/shared'
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

/** SSE 帧只取 `data:`，事件类型已经在负载里；`id:` 留给后续的断线续播。 */
function parseFrame(frame: string): AgentTurnEvent | null {
  const data = frame
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice(5)
    .trim()
  if (!data) return null
  try {
    return JSON.parse(data) as AgentTurnEvent
  } catch {
    return null
  }
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
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    let boundary = buffered.indexOf('\n\n')
    while (boundary !== -1) {
      const event = parseFrame(buffered.slice(0, boundary))
      buffered = buffered.slice(boundary + 2)
      if (event) yield event
      boundary = buffered.indexOf('\n\n')
    }
  }
}
