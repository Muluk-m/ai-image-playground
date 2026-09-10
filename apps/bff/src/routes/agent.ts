import type { AuthUserView } from '@image-playground/shared'
import {
  AGENT_DEVICE_ID_MAX_CHARS,
  AGENT_DEVICE_ID_MIN_CHARS,
  AGENT_USER_MESSAGE_MAX_CHARS,
  agentConversationTitle,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db } from '../db/client'
import {
  type AgentOwner,
  appendAgentMessage,
  createAgentConversation,
  findAgentConversation,
  listAgentMessages,
  setAgentConversationTitle,
  touchAgentConversation,
} from '../lib/agent/conversations'
import { agentTurnStream } from '../lib/agent/sse'
import { runAgentTurn } from '../lib/agent/turn'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'

const deviceIdSchema = t.String({
  minLength: AGENT_DEVICE_ID_MIN_CHARS,
  maxLength: AGENT_DEVICE_ID_MAX_CHARS,
})

/** 归属不依赖登录能力：有会话 cookie 就挂用户，否则挂设备。 */
function ownerOf(authUser: AuthUserView | null, deviceId: string): AgentOwner {
  return authUser ? { kind: 'user', userId: authUser.id } : { kind: 'device', deviceId }
}

const NOT_FOUND = { error: 'conversation_not_found' }

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
    { body: t.Object({ deviceId: deviceIdSchema }) },
  )
  .get(
    '/api/agent/conversations/:id/messages',
    async ({ params, query, authUser, status }) => {
      const owner = ownerOf(authUser, query.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      return { messages: await listAgentMessages(conversation.id) }
    },
    { params: t.Object({ id: t.String() }), query: t.Object({ deviceId: deviceIdSchema }) },
  )
  .post(
    '/api/agent/conversations/:id/turns',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)

      const history = await listAgentMessages(conversation.id)
      if (history.length === 0) {
        await setAgentConversationTitle(conversation.id, agentConversationTitle(body.text))
      }
      const turnId = crypto.randomUUID()
      const assistantMessageId = crypto.randomUUID()
      const userMessage = await appendAgentMessage(db, {
        conversationId: conversation.id,
        turnId,
        role: 'user',
        content: [{ type: 'text', text: body.text }],
      })

      const events = runAgentTurn(
        {
          turnId,
          userMessageId: userMessage.id,
          assistantMessageId,
          history,
          text: body.text,
        },
        // 失败的轮只留用户那条消息，助手侧不落库。
        async ({ text, error }) => {
          if (!error) {
            await appendAgentMessage(db, {
              id: assistantMessageId,
              conversationId: conversation.id,
              turnId,
              role: 'assistant',
              content: [{ type: 'text', text }],
            })
          }
          await touchAgentConversation(conversation.id)
        },
      )
      return agentTurnStream(events)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema,
        text: t.String({ minLength: 1, maxLength: AGENT_USER_MESSAGE_MAX_CHARS }),
      }),
    },
  )
