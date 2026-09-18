import type {
  AgentBackgroundJobsResponse,
  AgentConversationSnapshot,
  AgentMessageQueuedBody,
  AgentQueueFullBody,
  AuthUserView,
} from '@image-playground/shared'
import {
  AGENT_QUEUE_MAX_PENDING,
  AGENT_TURN_MAX_REFERENCES,
  AGENT_USER_MESSAGE_MAX_CHARS,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import sharp from 'sharp'
import { db, schema } from '../db/client'
import { cancelAgentConversationJobs } from '../lib/agent/background-jobs'
import {
  type AgentOwner,
  adoptDeviceConversations,
  createAgentConversation,
  findAgentConversation,
  listAgentConversations,
  listAgentMessages,
  softDeleteAgentConversation,
} from '../lib/agent/conversations'
import {
  isSealLease,
  lastConversationEventSeq,
  notifyConversation,
  openTurnEventBase,
  readConversationEvents,
  readTurnEvents,
  sealAbandonedTurns,
} from '../lib/agent/events'
import { agentInstance, conversationExecution, forwardActiveTurn } from '../lib/agent/execution'
import {
  agentInboxEntry,
  enqueueAgentUserMessage,
  type InboxEntry,
  queuedAgentMessages,
  withdrawAgentMessage,
} from '../lib/agent/inbox'
import { withAgentLifecycle } from '../lib/agent/lifecycle'
import { type RunningTurn, runningTurn } from '../lib/agent/runningTurns'
import { InvalidSelectionError, validateSelections } from '../lib/agent/selection-preview'
import { agentReplayStream, agentTurnStream } from '../lib/agent/sse'
import { drainConversationInbox } from '../lib/agent/start-turn'
import { agentTurnRateLimited } from '../lib/agent/turn-rate-limit'
import { listAgentTurnSummaries } from '../lib/agent/turn-summary'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { bffDrain } from '../lib/drain'
import { durableMediaStore } from '../lib/durableMediaStore'
import {
  badRequestOnValidation,
  clientAddress,
  deviceIdHeaderSchema,
  deviceIdSchema,
  imageDataUrlSchema,
} from '../lib/http'
import { log } from '../lib/logger'
import { objectStore } from '../lib/objectStore'
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

/**
 * 202 响应体按记录此刻的状态写：`consumed` 带处理它的那一轮，`pending` 带正在跑的那一轮。
 * 入队之后它可能已经被并发的收尾取走、被别的设备撤回，拿入队那一刻的状态会报错情况。
 */
function queuedBody(entry: InboxEntry, runningTurnId?: string): AgentMessageQueuedBody {
  const turnId =
    entry.state === 'consumed'
      ? (entry.consumedTurnId ?? undefined)
      : entry.state === 'pending'
        ? runningTurnId
        : undefined
  return { queued: entry.view, state: entry.state, ...(turnId ? { turnId } : {}) }
}

/** 重读这一条再回 202；记录没了（会话刚被删）就按已撤回报。 */
async function settledQueuedBody(
  conversationId: string,
  entry: InboxEntry,
  runningTurnId?: string,
): Promise<AgentMessageQueuedBody> {
  const now = (await agentInboxEntry(conversationId, entry.view.id)) ?? {
    ...entry,
    state: 'cancelled' as const,
  }
  return queuedBody(now, runningTurnId)
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
      // 被打断的轮先补上终帧，快照里的页脚与之后的增量才对得上。
      if (!local) await sealAbandonedTurns(conversation.id)
      const execution = await conversationExecution(conversation.id)
      const remote =
        execution && execution.instance !== agentInstance && !isSealLease(execution.turn_id)
          ? { turnId: execution.turn_id }
          : undefined
      const active = local ?? remote
      // 游标先于消息读：两次读取之间新落的东西会在增量里再来一遍（按 id 幂等），而不是漏掉。
      // 别的实例刚起的轮不给游标：它的开头可能已经落库、序号已经算进最大序号，
      // 从那之后接会把这一轮的开头整段漏掉；没有游标，客户端就按轮从头重放。
      const liveBase = local ? openTurnEventBase(conversation.id, local.turnId) : undefined
      const cursor = remote
        ? undefined
        : (liveBase ?? (await lastConversationEventSeq(conversation.id)))
      const [messages, turns, queue] = await Promise.all([
        listAgentMessages(conversation.id, owner),
        listAgentTurnSummaries(conversation.id),
        queuedAgentMessages(conversation.id),
      ])
      // 没有谁在跑、队里却还有待处理的：收尾的那个实例下线了或半路没了。这里接着开轮，
      // 不必等定时巡查；客户端再看一次快照就挂得上。
      if (!execution && queue.some((one) => !one.failure) && !bffDrain.status().draining)
        void drainConversationInbox(conversation.id).catch((err) =>
          log.error(
            { event: 'agent.inbox_drain_failed', conversationId: conversation.id, err },
            'queued agent message could not start a turn',
          ),
        )
      const snapshot: AgentConversationSnapshot = {
        messages,
        turns,
        // 刷新后的页面据此挂回仍在进行的那一轮。
        activeTurn: active ? { turnId: active.turnId } : null,
        ...(cursor === undefined ? {} : { cursor }),
        queue,
      }
      return snapshot
    },
    { params: t.Object({ id: t.String() }), headers: deviceIdHeaderSchema() },
  )
  .get(
    '/api/agent/conversations/:id/messages/:messageId/references/:index',
    async ({ params, headers, authUser, status }) => {
      const conversation = await findAgentConversation(
        params.id,
        ownerOf(authUser, headers[DEVICE_ID_HEADER]),
      )
      if (!conversation) return status(404, NOT_FOUND)
      const [message] = await db
        .select({ content: schema.agent_messages.content })
        .from(schema.agent_messages)
        .where(
          and(
            eq(schema.agent_messages.id, params.messageId),
            eq(schema.agent_messages.conversation_id, conversation.id),
            eq(schema.agent_messages.role, 'user'),
            isNull(schema.agent_messages.deleted_at),
          ),
        )
        .limit(1)
      const references = message?.content.flatMap((block) =>
        block.type === 'text' ? (block.references ?? []) : [],
      )
      const reference = references?.[params.index]
      if (!reference) return status(404, { error: 'reference_not_found' })
      try {
        const store = reference.image.store === 'durable' ? durableMediaStore() : objectStore()
        const thumbnail = await sharp(await store.read(reference.image.object))
          .rotate()
          .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        return new Response(thumbnail, {
          headers: {
            'content-type': 'image/webp',
            'cache-control': 'private, max-age=31536000, immutable',
            vary: `Cookie, ${DEVICE_ID_HEADER}`,
          },
        })
      } catch {
        return status(502, { error: 'object_storage_error' })
      }
    },
    {
      params: t.Object({
        id: t.String(),
        messageId: t.String(),
        index: t.Integer({ minimum: 0, maximum: AGENT_TURN_MAX_REFERENCES - 1 }),
      }),
      headers: deviceIdHeaderSchema(),
    },
  )
  .get(
    // 这个会话提交过的后台任务，结果块是此刻的样子（读取即结算）。面板有没结束的任务时靠它
    // 等结果：它只读任务表与消息表，不跟轮，所以不用转发到跑着轮的实例。
    '/api/agent/conversations/:id/jobs',
    async ({ params, headers, authUser, status }) => {
      const owner = ownerOf(authUser, headers[DEVICE_ID_HEADER])
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const messages = await listAgentMessages(conversation.id, owner)
      const response: AgentBackgroundJobsResponse = {
        jobs: messages.flatMap((message) =>
          message.content.flatMap((block) =>
            block.type === 'toolResult' && block.job
              ? [{ messageId: message.id, turnId: message.turnId, result: block }]
              : [],
          ),
        ),
      }
      return response
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
        // 会话在别的实例上跑着：排队与通知都得落在那边，那一轮收尾时才取得到。
        const forwarded = await forwardActiveTurn(conversation.id, request, body)
        if (forwarded) return forwarded

        try {
          await validateSelections(body.references ?? [])
        } catch (error) {
          if (error instanceof InvalidSelectionError)
            return status(422, { error: 'invalid_selection' })
          throw error
        }
        // 开不了轮的请求不进收件箱：排进去也没有哪一轮能取走它。
        if (isCapabilityEnabled('billing:credits') && owner.kind !== 'user')
          return status(401, { error: 'unauthorized' })
        if (bffDrain.status().draining) return status(503, { error: 'instance_draining' })

        // 每条消息先进收件箱，再按顺序开轮：忙时它排在后面，闲时它当场就是下一条。
        const enqueued = await enqueueAgentUserMessage(conversation.id, {
          clientMessageId: body.clientMessageId ?? crypto.randomUUID(),
          text: body.text,
          references: body.references ?? [],
          deviceId: body.deviceId,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.params ? { params: body.params } : {}),
        })
        if (enqueued.kind === 'full') {
          const full: AgentQueueFullBody = { error: 'queue_full', limit: AGENT_QUEUE_MAX_PENDING }
          return status(409, full)
        }
        const { entry } = enqueued
        if (enqueued.kind === 'duplicate') {
          // 网络重发的同一条：交回它此刻的状态，不排第二次、不开第二轮。
          return status(202, queuedBody(entry, runningTurn(conversation.id)?.turnId))
        }

        const local = runningTurn(conversation.id)
        if (local) {
          notifyConversation(conversation.id, { type: 'messageQueued', message: entry.view })
          return status(202, queuedBody(entry, local.turnId))
        }
        const drained = await drainConversationInbox(conversation.id, { quietFor: entry.view.id })
        if (drained.kind === 'started' && drained.queueId === entry.view.id)
          return agentTurnStream(drained.turn.read(0))
        if (drained.kind !== 'not_started' || drained.queueId !== entry.view.id) {
          // 这一条没有当场开轮：前面还排着别的、会话被别处占着、被别的设备撤回了，或者被并发的
          // 收尾取走了。重读它此刻的状态再回报。
          const running =
            drained.kind === 'started'
              ? drained.turn.turnId
              : drained.kind === 'already_running'
                ? drained.turnId
                : undefined
          const body = await settledQueuedBody(conversation.id, entry, running)
          if (body.state === 'pending')
            notifyConversation(conversation.id, { type: 'messageQueued', message: body.queued })
          return status(202, body)
        }
        // 开不了轮（余额不足等）：这一条不留在队里，照旧把原因交回去，草稿留在输入框。
        await withdrawAgentMessage(conversation.id, entry.view.id)
        const { failure } = drained
        if (failure.kind === 'draining') return status(503, { error: 'instance_draining' })
        if (failure.kind === 'authentication_required')
          return status(401, { error: 'unauthorized' })
        return reservationFailureResponse(failure)
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
        /** 客户端为这条消息生成的 id：网络重发时据此认出同一条，不排两次。 */
        clientMessageId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
      }),
    },
  )
  .get(
    // 还排着的消息，按处理顺序。刷新、换设备都读这一份。
    '/api/agent/conversations/:id/queue',
    async ({ params, headers, authUser, status }) => {
      const conversation = await findAgentConversation(
        params.id,
        ownerOf(authUser, headers[DEVICE_ID_HEADER]),
      )
      if (!conversation) return status(404, NOT_FOUND)
      return { queue: await queuedAgentMessages(conversation.id) }
    },
    { params: t.Object({ id: t.String() }), headers: deviceIdHeaderSchema() },
  )
  .post(
    '/api/agent/conversations/:id/queue/:queueId/withdraw',
    async ({ params, body, authUser, status, request }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      // 撤回的通知要进正在跑的那一轮的事件流，所以落在它所在的实例上。
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      const { result, fresh } = await withdrawAgentMessage(conversation.id, params.queueId)
      if (fresh)
        notifyConversation(conversation.id, {
          type: 'queuedMessageWithdrawn',
          queueId: params.queueId,
        })
      return { result }
    },
    {
      params: t.Object({ id: t.String(), queueId: t.String({ maxLength: 128 }) }),
      body: t.Object({ deviceId: deviceIdSchema() }),
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
        // 删掉的会话不该接着花钱：没结束的后台任务一并取消，按原桶退回。
        await cancelAgentConversationJobs(conversation.id)
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
      await sealAbandonedTurns(conversation.id)
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
  .get(
    // 会话级增量：快照之后的全部事件，跨轮按序号续播；有轮在跑就跟到它收尾。
    '/api/agent/conversations/:id/events',
    async ({ params, headers, authUser, status, request }) => {
      const owner = ownerOf(authUser, headers[DEVICE_ID_HEADER])
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)

      const forwarded = await forwardActiveTurn(conversation.id, request)
      if (forwarded) return forwarded
      await sealAbandonedTurns(conversation.id)
      return agentTurnStream(
        await readConversationEvents(conversation.id, lastEventId(headers['last-event-id'])),
      )
    },
    {
      params: t.Object({ id: t.String() }),
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
