import {
  type AgentMessageView,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { type AgentCall, parseFrames } from '../../../helpers/agentStubs'

export const DEVICE = 'device-abcdefgh'
export const USER_ID = 'golden-eval-owner'

export const STRUCTURED_ENGLISH_PROMPT = [
  'cinematic product photo, red enamel kettle on marble counter,',
  'soft window light from the left, shallow depth of field, 85mm, --ar 4:5',
].join(' ')

export const DESIGN_HEAD = '画面要表达（用视觉呈现，不作为图中文字）：'

type App = { handle(request: Request): Promise<Response> }

export interface EvalClient {
  readonly app: App
  readonly cookie: string
}

export function request(
  client: EvalClient,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return client.app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
        cookie: client.cookie,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
}

export async function startConversation(client: EvalClient): Promise<string> {
  const response = await request(client, '/api/agent/conversations', {
    method: 'POST',
    body: { deviceId: DEVICE },
  })
  if (!response.ok) throw new Error(`create conversation returned ${response.status}`)
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

export interface RunTurnOptions {
  readonly text: string
  readonly params?: Record<string, unknown>
  readonly experience?: 'chat' | 'canvas'
  readonly mode?: 'image' | 'video'
}

export async function runTurn(
  client: EvalClient,
  conversationId: string,
  options: RunTurnOptions,
  idle: (conversationId: string) => Promise<void>,
) {
  const response = await request(client, `/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: {
      deviceId: DEVICE,
      text: options.text,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.params ? { params: options.params } : {}),
      ...(options.experience
        ? { experience: options.experience, surface: options.experience }
        : {}),
    },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  await idle(conversationId)
  return parseFrames(body)
}

export async function snapshotMessages(
  client: EvalClient,
  conversationId: string,
): Promise<AgentMessageView[]> {
  const response = await request(client, `/api/agent/conversations/${conversationId}/messages`)
  if (!response.ok) throw new Error(`snapshot returned ${response.status}`)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

export function toolCards(messages: readonly AgentMessageView[]): AgentToolResultBlock[] {
  return messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'toolResult' ? [block] : [])),
  )
}

export function toolNamesOf(call: AgentCall): string[] {
  return call.tools?.map((tool) => tool.function.name) ?? []
}

export function textOf(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return JSON.stringify(message.content ?? '')
  return message.content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const record = block as { type?: string; text?: string }
      return record.type === 'text' ? (record.text ?? '') : JSON.stringify(block)
    })
    .join('\n')
}

export function lastUserText(call: AgentCall): string {
  const user = [...call.messages].reverse().find((message) => message.role === 'user')
  return user ? textOf(user) : ''
}

export function systemText(call: AgentCall): string {
  const first = call.messages[0]
  return first?.role === 'system' ? textOf(first) : ''
}

export function overloadedResponse(): Response {
  return Response.json(
    { error: { message: 'Our servers are currently overloaded. Please try again later.' } },
    { status: 503 },
  )
}
