import type { AuthUserView } from '@image-playground/shared'
import { AGENT_USER_MESSAGE_MAX_CHARS, agentConversationTitle } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db } from '../db/client'
import {
  type AgentOwner,
  appendAgentMessage,
  createAgentConversation,
  findAgentConversation,
  listAgentMessages,
  setAgentConversationTitle,
} from '../lib/agent/conversations'
import { readAgentTurnEvents } from '../lib/agent/events'
import { runningTurn } from '../lib/agent/runningTurns'
import { agentReplayStream, agentTurnStream } from '../lib/agent/sse'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { badRequestOnValidation, deviceIdSchema } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'

/** 归属不依赖登录能力：有会话 cookie 就挂用户，否则挂设备。 */
function ownerOf(authUser: AuthUserView | null, deviceId: string): AgentOwner {
  return authUser ? { kind: 'user', userId: authUser.id } : { kind: 'device', deviceId }
}

const NOT_FOUND = { error: 'conversation_not_found' }
const TURN_NOT_FOUND = { error: 'turn_not_found' }

const turnParams = t.Object({ id: t.String(), turnId: t.String() })

/** `Last-Event-ID` 是 SSE 规范里的重连头；缺席就是从头要一遍这一轮。 */
function lastEventId(headers: Record<string, string | undefined>): number {
  const parsed = Number(headers['last-event-id'])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export const agentRoutes = new Elysia()
  .use(badRequestOnValidation())
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('agent:chat')) return capabilityUnavailable('agent:chat')
  })
  .use(resolveAuthUser)
  .post(
    '/api/agent/conversations',
    async ({ body, authUser }) => ({
      conversation: await createAgentConversation(ownerOf(authUser, body.deviceId), ''),
    }),
    { body: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .get(
    '/api/agent/conversations/:id/messages',
    async ({ params, query, authUser, status }) => {
      const owner = ownerOf(authUser, query.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const active = runningTurn(conversation.id)
      return {
        messages: await listAgentMessages(conversation.id),
        // 刷新后的页面据此挂回仍在进行的那一轮。
        activeTurn: active ? { turnId: active.turnId } : null,
      }
    },
    { params: t.Object({ id: t.String() }), query: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .post(
    '/api/agent/conversations/:id/turns',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      if (runningTurn(conversation.id)) return status(409, { error: 'turn_already_running' })

      const history = await listAgentMessages(conversation.id)
      if (history.length === 0) {
        await setAgentConversationTitle(conversation.id, agentConversationTitle(body.text))
      }
      const turnId = crypto.randomUUID()
      const userMessage = await appendAgentMessage(db, {
        conversationId: conversation.id,
        turnId,
        role: 'user',
        content: [{ type: 'text', text: body.text }],
      })

      // 动态引入：pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付。
      const { startAgentTurn } = await import('../lib/agent/turn')
      const turn = await startAgentTurn({
        conversationId: conversation.id,
        turnId,
        userMessageId: userMessage.id,
        history,
        text: body.text,
      })
      return agentTurnStream(turn.read(0))
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema(),
        text: t.String({ minLength: 1, maxLength: AGENT_USER_MESSAGE_MAX_CHARS }),
      }),
    },
  )
  .get(
    '/api/agent/conversations/:id/turns/:turnId/events',
    async ({ params, query, headers, authUser, status }) => {
      const owner = ownerOf(authUser, query.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)

      const after = lastEventId(headers)
      const active = runningTurn(conversation.id)
      if (active?.turnId === params.turnId) return agentTurnStream(active.read(after))

      const stored = await readAgentTurnEvents(conversation.id, params.turnId, after)
      // 断点之后没有新事件不代表轮不存在；只有整轮都查不到才是没这一轮。
      if (
        stored.length === 0 &&
        (await readAgentTurnEvents(conversation.id, params.turnId, 0)).length === 0
      ) {
        return status(404, TURN_NOT_FOUND)
      }
      return agentReplayStream(stored)
    },
    { params: turnParams, query: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .post(
    '/api/agent/conversations/:id/turns/:turnId/abort',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const active = runningTurn(conversation.id)
      if (active?.turnId !== params.turnId) return status(404, TURN_NOT_FOUND)
      active.abort()
      return { aborted: true }
    },
    { params: turnParams, body: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .post(
    '/api/agent/conversations/:id/turns/:turnId/interject',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const active = runningTurn(conversation.id)
      if (active?.turnId !== params.turnId) return status(404, TURN_NOT_FOUND)
      return { messageId: active.interject(body.text) }
    },
    {
      params: turnParams,
      body: t.Object({
        deviceId: deviceIdSchema(),
        text: t.String({ minLength: 1, maxLength: AGENT_USER_MESSAGE_MAX_CHARS }),
      }),
    },
  )
