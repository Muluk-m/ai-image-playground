import type { AgentTurnAlreadyRunningBody, AuthUserView } from '@image-playground/shared'
import {
  AGENT_TURN_MAX_REFERENCES,
  AGENT_USER_MESSAGE_MAX_CHARS,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import {
  type AgentOwner,
  adoptDeviceConversations,
  createAgentConversation,
  findAgentConversation,
  listAgentConversations,
  listAgentMessages,
  softDeleteAgentConversation,
} from '../lib/agent/conversations'
import { readTurnEvents } from '../lib/agent/events'
import { agentInstance, conversationExecution, forwardActiveTurn } from '../lib/agent/execution'
import { withAgentLifecycle } from '../lib/agent/lifecycle'
import { type RunningTurn, runningTurn } from '../lib/agent/runningTurns'
import { InvalidSelectionError, validateSelections } from '../lib/agent/selection-preview'
import { agentReplayStream, agentTurnStream } from '../lib/agent/sse'
import { startConversationTurn } from '../lib/agent/start-turn'
import { agentTurnRateLimited } from '../lib/agent/turn-rate-limit'
import { listAgentTurnSummaries } from '../lib/agent/turn-summary'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  badRequestOnValidation,
  clientAddress,
  deviceIdHeaderSchema,
  deviceIdSchema,
  imageDataUrlSchema,
} from '../lib/http'
import { reservationFailureResponse } from '../lib/private-overlay'
import { resolveAuthUser } from '../lib/user-auth'

/** 归属不依赖登录能力：有会话 cookie 就挂用户，否则挂设备。 */
function ownerOf(authUser: AuthUserView | null, deviceId: string): AgentOwner {
  return authUser ? { kind: 'user', userId: authUser.id } : { kind: 'device', deviceId }
}

const NOT_FOUND = { error: 'conversation_not_found' }
const TURN_NOT_FOUND = { error: 'turn_not_found' }

/** 参考图按数组顺序编号，提示词里的 `[image N]` 就是这里的第 N 项。 */
/**
 * 参数浮层里选的生成参数。全部可选：没选的项由部署默认补齐，选了坏值也不该让整轮失败——
 * 映射那一步会把认不得的值丢掉（见 `lib/agent/tools/queueParams.ts`）。
 */
const paramsSchema = t.Optional(
  t.Object({
    thinkingDepth: t.Optional(t.Union([t.Literal('fast'), t.Literal('medium'), t.Literal('deep')])),
    model: t.Optional(t.String({ maxLength: 128 })),
    size: t.Optional(t.String({ maxLength: 32 })),
    quality: t.Optional(t.String({ maxLength: 16 })),
    output_format: t.Optional(t.String({ maxLength: 16 })),
    output_compression: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
    gemini_aspect_ratio: t.Optional(t.String({ maxLength: 16 })),
    gemini_image_size: t.Optional(t.String({ maxLength: 16 })),
    gemini_thinking_level: t.Optional(t.String({ maxLength: 16 })),
  }),
)

const referencesSchema = t.Optional(
  t.Array(
    t.Object({
      imageId: t.String({ minLength: 1, maxLength: 128 }),
      dataUrl: imageDataUrlSchema(),
      name: t.Optional(t.String({ maxLength: 200 })),
      maskDataUrl: t.Optional(imageDataUrlSchema()),
    }),
    { maxItems: AGENT_TURN_MAX_REFERENCES },
  ),
)

/** 创作类型。缺席即图片：老客户端不发这一项，它们要的从来都是图。 */
const modeSchema = t.Optional(t.Union([t.Literal('image'), t.Literal('video')]))

const turnParams = t.Object({ id: t.String(), turnId: t.String() })
const turnBody = t.Object({ deviceId: deviceIdSchema() })

/** 轮级端点共用这段：归属查会话、会话查在跑的轮，两级查不到都是同一个 404。 */
async function activeTurnOf(
  params: { id: string; turnId: string },
  deviceId: string,
  authUser: AuthUserView | null,
): Promise<RunningTurn | null> {
  const conversation = await findAgentConversation(params.id, ownerOf(authUser, deviceId))
  const active = conversation ? runningTurn(conversation.id) : undefined
  return active?.turnId === params.turnId ? active : null
}

function lastEventId(raw: string | undefined): number {
  const parsed = Number(raw)
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
    async ({ params, headers, authUser, status, request }) => {
      const owner = ownerOf(authUser, headers[DEVICE_ID_HEADER])
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const forwarded = await forwardActiveTurn(conversation.id, request)
      if (forwarded) return forwarded
      const local = runningTurn(conversation.id)
      const execution = await conversationExecution(conversation.id)
      const active =
        local ??
        (execution && execution.instance !== agentInstance
          ? { turnId: execution.turn_id }
          : undefined)
      const [messages, turns] = await Promise.all([
        listAgentMessages(conversation.id, owner),
        listAgentTurnSummaries(conversation.id),
      ])
      return {
        messages,
        turns,
        // 刷新后的页面据此挂回仍在进行的那一轮。
        activeTurn: active ? { turnId: active.turnId } : null,
      }
    },
    { params: t.Object({ id: t.String() }), headers: deviceIdHeaderSchema() },
  )
  .post(
    '/api/agent/conversations/:id/turns',
    async ({ params, body, authUser, request, server, status }) => {
      const address = clientAddress(request, server?.requestIP(request)?.address ?? null)
      if (agentTurnRateLimited(body.deviceId, address)) {
        return status(429, { error: 'rate_limited' })
      }

      const owner = ownerOf(authUser, body.deviceId)
      return withAgentLifecycle(owner, async () => {
        const conversation = await findAgentConversation(params.id, owner)
        if (!conversation) return status(404, NOT_FOUND)
        // 409 带上在跑的那一轮：另一个标签页占着会话时，客户端据此转去续播而不是报错。
        const forwarded = await forwardActiveTurn(conversation.id, request, body)
        if (forwarded) return forwarded
        const local = runningTurn(conversation.id)
        const execution = await conversationExecution(conversation.id)
        const active =
          local ??
          (execution && execution.instance !== agentInstance
            ? { turnId: execution.turn_id }
            : undefined)
        if (active) {
          const body: AgentTurnAlreadyRunningBody = {
            error: 'turn_already_running',
            turnId: active.turnId,
          }
          return status(409, body)
        }

        try {
          await validateSelections(body.references ?? [])
        } catch (error) {
          if (error instanceof InvalidSelectionError)
            return status(422, { error: 'invalid_selection' })
          throw error
        }
        const started = await startConversationTurn({
          conversationId: conversation.id,
          owner,
          text: body.text,
          references: body.references ?? [],
          deviceId: body.deviceId,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.params ? { params: body.params } : {}),
        })
        if (started.kind === 'already_running')
          return status(409, { error: 'turn_already_running', turnId: started.turnId })
        if (started.kind === 'draining') return status(503, { error: 'instance_draining' })
        if (started.kind === 'authentication_required')
          return status(401, { error: 'unauthorized' })
        if (started.kind !== 'started') return reservationFailureResponse(started)
        return agentTurnStream(started.turn.read(0))
      })
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema(),
        text: t.String({ minLength: 1, maxLength: AGENT_USER_MESSAGE_MAX_CHARS }),
        references: referencesSchema,
        mode: modeSchema,
        params: paramsSchema,
      }),
    },
  )
  .get(
    // 输入框打 `/` 时的候选。只有名字与「何时用」：正文是给模型读的，不是给这个弹层读的。
    '/api/agent/skills',
    async ({ query }) => {
      // 动态引入：`skills` 与 `tools` 静态依赖 pi，模块图不该因为一条清单端点被提到路由加载时。
      const [{ agentSkillSummaries, ensureAgentSkills }, { resolveAgentMode }] = await Promise.all([
        import('../lib/agent/skills'),
        import('../lib/agent/tools'),
      ])
      await ensureAgentSkills()
      // 做不了视频的部署里没有视频轮，所以也没有只有视频轮看得见的技能。
      return { skills: agentSkillSummaries(resolveAgentMode(query.mode ?? 'image')) }
    },
    { query: t.Object({ mode: modeSchema }) },
  )
  .get(
    '/api/agent/conversations',
    async ({ headers, authUser }) => ({
      conversations: await listAgentConversations(ownerOf(authUser, headers[DEVICE_ID_HEADER])),
    }),
    { headers: deviceIdHeaderSchema() },
  )
  .delete(
    '/api/agent/conversations/:id',
    async ({ params, body, authUser, status, request }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      return withAgentLifecycle(owner, async () => {
        if (runningTurn(conversation.id) || (await conversationExecution(conversation.id)))
          return status(409, { error: 'conversation_busy' })
        if (owner.kind === 'user') {
          const [project] = await db
            .select({ id: schema.canvas_projects.id })
            .from(schema.canvas_projects)
            .where(
              and(
                eq(schema.canvas_projects.user_id, owner.userId),
                eq(schema.canvas_projects.conversation_id, conversation.id),
              ),
            )
            .limit(1)
          if (project) return status(409, { error: 'project_conversation_bound' })
        }
        await softDeleteAgentConversation(conversation.id, owner)
        return { ok: true }
      })
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .post(
    '/api/agent/conversations/adopt',
    async ({ body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return { adopted: await adoptDeviceConversations(body.deviceId, authUser.id) }
    },
    { body: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .get(
    '/api/agent/conversations/:id/turns/:turnId/events',
    async ({ params, headers, authUser, status, request }) => {
      const owner = ownerOf(authUser, headers[DEVICE_ID_HEADER])
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)

      const forwarded = await forwardActiveTurn(conversation.id, request)
      if (forwarded) return forwarded
      const feed = await readTurnEvents(
        conversation.id,
        params.turnId,
        lastEventId(headers['last-event-id']),
      )
      if (feed.kind === 'no-such-turn') return status(404, TURN_NOT_FOUND)
      return feed.kind === 'live' ? agentTurnStream(feed.events) : agentReplayStream(feed.events)
    },
    {
      params: turnParams,
      // 断点头得进 schema：没声明的头会被 Elysia 归一化掉，续播就从头重放。
      headers: t.Object({
        [DEVICE_ID_HEADER]: deviceIdSchema(),
        'last-event-id': t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/agent/conversations/:id/turns/:turnId/abort',
    async ({ params, body, authUser, status, request }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      const activeTurn = await activeTurnOf(params, body.deviceId, authUser)
      if (!activeTurn) return status(404, TURN_NOT_FOUND)
      activeTurn.abort()
      return { aborted: true }
    },
    { params: turnParams, body: turnBody },
  )
  .post(
    '/api/agent/conversations/:id/turns/:turnId/interject',
    async ({ params, body, authUser, status, request }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      const activeTurn = await activeTurnOf(params, body.deviceId, authUser)
      if (!activeTurn) return status(404, TURN_NOT_FOUND)
      let messageId: string | null
      try {
        messageId = await activeTurn.interject(body.text, body.references)
      } catch (error) {
        if (error instanceof InvalidSelectionError)
          return status(422, { error: 'invalid_selection' })
        throw error
      }
      return messageId ? { messageId } : status(409, { error: 'turn_finished' })
    },
    {
      params: turnParams,
      body: t.Object({
        deviceId: deviceIdSchema(),
        text: t.String({ minLength: 1, maxLength: AGENT_USER_MESSAGE_MAX_CHARS }),
        references: referencesSchema,
      }),
    },
  )
