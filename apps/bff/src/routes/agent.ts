import type {
  AgentBackgroundJobCancelResponse,
  AgentBackgroundJobsResponse,
  AgentConfirmationRefusedBody,
  AgentConfirmationResponse,
  AgentConversationSnapshot,
  AgentMessageQueuedBody,
  AgentQueueFullBody,
  AgentQueueInterjectResult,
  AgentRetryRefusedBody,
  AgentRetryResponse,
  AgentSaveResponse,
  AgentTurnAbortedBody,
  AgentTurnReference,
  AuthUserView,
} from '@image-playground/shared'
import {
  AGENT_QUEUE_MAX_PENDING,
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_TURN_MAX_REFERENCES,
  AGENT_USER_MESSAGE_MAX_CHARS,
  DEVICE_ID_HEADER,
  SYNC_NAME_MAX_LENGTH,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import sharp from 'sharp'
import { db, schema } from '../db/client'
import {
  agentJobViews,
  cancelAgentConversationJobs,
  cancelAgentJob,
} from '../lib/agent/background-jobs'
import {
  confirmAgentGeneration,
  discardConversationDraftInputs,
  lockConversation,
} from '../lib/agent/confirmations'
import {
  type AgentOwner,
  adoptDeviceConversations,
  createAgentConversation,
  findAgentConversation,
  listAgentConversations,
  listAgentMessages,
  softDeleteAgentConversation,
} from '../lib/agent/conversations'
import { type CookieJar, ensureDeviceClaim, holdsDeviceClaim } from '../lib/agent/deviceClaim'
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
  claimConversationMedia,
  readConversationMedia,
  removeAgentConversationReferences,
} from '../lib/agent/images'
import {
  agentInboxEntry,
  claimAgentMessageForInterjection,
  enqueueAgentUserMessage,
  hasPendingAgentWake,
  type InboxEntry,
  pendingAgentMessage,
  queuedAgentMessages,
  requeueAgentMessage,
  returnAgentMessages,
  returnedAgentMessages,
  settleAgentInterjection,
  withdrawAgentMessage,
} from '../lib/agent/inbox'
import { withAgentLifecycle } from '../lib/agent/lifecycle'
import {
  advanceAgentRetryQueueSafely,
  cancelAgentRetry,
  retryAgentToolCall,
} from '../lib/agent/retry'
import {
  beginTurnStop,
  claimForTurn,
  type RunningTurn,
  runningTurn,
  turnStopping,
} from '../lib/agent/runningTurns'
import { markAgentSaveCardSaved } from '../lib/agent/saves'
import { InvalidSelectionError, validateSelections } from '../lib/agent/selection-preview'
import { agentReplayStream, agentTurnStream } from '../lib/agent/sse'
import { drainConversationInbox } from '../lib/agent/start-turn'
import { agentTurnRateLimited } from '../lib/agent/turn-rate-limit'
import { agentTurnSettled, listAgentTurnSummaries } from '../lib/agent/turn-summary'
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

/** 历史引用的回显字节。它按 id 不可变，可以长缓存；但只对这一个人成立，所以是 private。 */
function referenceHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'private, max-age=31536000, immutable',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    vary: `Cookie, ${DEVICE_ID_HEADER}`,
  }
}

/**
 * 参数浮层里选的生成参数。全部可选：没选的项由部署默认补齐，选了坏值也不该让整轮失败——
 * 映射那一步会把认不得的值丢掉（见 `lib/agent/tools/queueParams.ts`）。
 */
const paramsSchema = t.Optional(
  t.Object({
    thinkingDepth: t.Optional(t.Union([t.Literal('fast'), t.Literal('medium'), t.Literal('deep')])),
    model: t.Optional(t.String({ maxLength: 128 })),
    /** 出图模式：只认显式 true，缺席即对话模式（拟稿等确认）。 */
    autoSubmit: t.Optional(t.Literal(true)),
    size: t.Optional(t.String({ maxLength: 32 })),
    quality: t.Optional(t.String({ maxLength: 16 })),
    output_format: t.Optional(t.String({ maxLength: 16 })),
    output_compression: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
    gemini_aspect_ratio: t.Optional(t.String({ maxLength: 16 })),
    gemini_image_size: t.Optional(t.String({ maxLength: 16 })),
    gemini_thinking_level: t.Optional(t.String({ maxLength: 16 })),
  }),
)

/**
 * 一张参考图。字节只在浏览器里的内联发过来；已经在云媒体里的（画布上选中的原图）
 * 只发 id——八张原图内联一次就是几十 MB 的请求体，传几分钟还白占一遍出站带宽。
 *
 * 两路合成一个对象、由 `turnReferences` 分辨，而不是写成 `t.Union`：exact-mirror 没有
 * TypeCompiler 时不支持 Union，路由一编译就是一条启动期告警，而且那条路由从此不再做
 * 请求体裁剪。云媒体那一路没有遮罩：画遮罩、烧批注都产出新像素，那张图在 R2 里并不存在。
 */
const referencesSchema = t.Optional(
  t.Array(
    t.Object({
      imageId: t.String({ minLength: 1, maxLength: 128 }),
      dataUrl: t.Optional(imageDataUrlSchema()),
      mediaId: t.Optional(t.String({ format: 'uuid' })),
      name: t.Optional(t.String({ maxLength: 200 })),
      maskDataUrl: t.Optional(imageDataUrlSchema()),
    }),
    { maxItems: AGENT_TURN_MAX_REFERENCES },
  ),
)

type ReferenceBody = NonNullable<(typeof referencesSchema)['static']>[number]

/**
 * 两路只能二选一：都给或都不给都是坏请求，分不清该拿哪一份字节。
 *
 * 内联那一路另有硬上限（{@link AGENT_TURN_MAX_INLINE_REFERENCES}）：一轮的总张数放宽到几十张
 * 靠的是「按 id 发、字节不进请求体」，真带字节的那几张一多，请求体还是几十 MB，传几分钟
 * 再白占一遍出站带宽。超了当坏请求打回，用户的话还在输入框里。
 */
function turnReferences(raw: readonly ReferenceBody[]): AgentTurnReference[] | null {
  const references: AgentTurnReference[] = []
  let inline = 0
  for (const one of raw) {
    const name = one.name ? { name: one.name } : {}
    if (one.mediaId && !one.dataUrl)
      references.push({ imageId: one.imageId, ...name, mediaId: one.mediaId })
    else if (one.dataUrl && !one.mediaId) {
      inline += 1
      references.push({
        imageId: one.imageId,
        ...name,
        dataUrl: one.dataUrl,
        ...(one.maskDataUrl ? { maskDataUrl: one.maskDataUrl } : {}),
      })
    } else return null
  }
  return inline > AGENT_TURN_MAX_INLINE_REFERENCES ? null : references
}

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

/**
 * 这个会话此刻是不是真有一轮在跑。
 *
 * 不能只看租约行：轮收尾时**先**落页脚、发终帧、关流，**再**异步把租约还回去，所以客户端看见
 * 这一轮结束之后的那一小段时间里，租约行仍然是 running。把它当「忙」，用户刚看完一轮就删不掉
 * 会话——2026-09-22 main 上 `agent-confirmations` 那格红灯正是撞进了这个窗口。
 * 落过页脚的那一轮按定义已经结束；没落页脚的（崩掉的执行者、封印租约）仍然算忙，由恢复扫描收尾。
 */
async function conversationBusy(conversationId: string): Promise<boolean> {
  if (runningTurn(conversationId)) return true
  const execution = await conversationExecution(conversationId)
  if (!execution) return false
  return !(await agentTurnSettled(conversationId, execution.turn_id))
}

export const agentRoutes = new Elysia()
  .use(badRequestOnValidation())
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('agent:chat')) return capabilityUnavailable('agent:chat')
  })
  .use(resolveAuthUser)
  // 匿名流量顺路登记持有性证明。放在这里而不是只放在建会话上：已有用户没有登记行，
  // 下一次任何一个请求就把他们补上，缩短「标识已泄漏但还没人登记」的窗口。
  .onBeforeHandle(async ({ authUser, headers, body, cookie }) => {
    if (authUser) return
    const deviceId =
      headers[DEVICE_ID_HEADER] ||
      (typeof body === 'object' && body && 'deviceId' in body && typeof body.deviceId === 'string'
        ? body.deviceId
        : '')
    if (deviceId) await ensureDeviceClaim(deviceId, cookie as CookieJar)
  })
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
      // 没有谁在跑、队里却还有待处理的（排队消息或唤醒）：收尾的那个实例下线了或半路没了。
      // 这里接着开轮，不必等定时巡查；客户端再看一次快照就挂得上。
      if (
        !execution &&
        !bffDrain.status().draining &&
        (queue.some((one) => !one.failure) || (await hasPendingAgentWake(conversation.id)))
      )
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
    async ({ params, query, headers, authUser, status }) => {
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
      const original = query.variant === 'original'
      try {
        // 云媒体那一路没有副本：缩略图直接用上传时就备好的预览，别把原件拉回来再缩一遍。
        if ('mediaId' in reference) {
          const media = await readConversationMedia(
            reference.mediaId,
            conversation.id,
            authUser?.id ?? null,
            original ? 'original' : 'preview',
          )
          if (!media) return status(404, { error: 'reference_not_found' })
          return new Response(media.bytes as Uint8Array<ArrayBuffer>, {
            headers: referenceHeaders(media.contentType),
          })
        }
        const store = reference.image.store === 'durable' ? durableMediaStore() : objectStore()
        const bytes = await store.read(reference.image.object)
        const image = original
          ? bytes
          : await sharp(bytes)
              .rotate()
              .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 80 })
              .toBuffer()
        return new Response(image, {
          headers: referenceHeaders(original ? reference.image.mime : 'image/webp'),
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
      query: t.Object({
        variant: t.Optional(t.Union([t.Literal('thumbnail'), t.Literal('original')])),
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
      // 看着这个会话的客户端每次来问，顺手推一下重试队列：前一条刚结束，下一条不必等巡到。
      await advanceAgentRetryQueueSafely(conversation.id)
      const messages = await listAgentMessages(conversation.id, owner)
      const response: AgentBackgroundJobsResponse = {
        jobs: await agentJobViews(conversation.id, messages),
      }
      return response
    },
    { params: t.Object({ id: t.String() }), headers: deviceIdHeaderSchema() },
  )
  .post(
    // 单独取消一个后台任务，按原桶退回；回的是取消之后这次调用的样子。已经结束的任务原样返回，
    // 两台设备同时点取消只有一次真正生效。只动任务表，不跟轮，所以同样不用转发。
    '/api/agent/conversations/:id/jobs/:taskId/cancel',
    async ({ params, headers, authUser, status }) => {
      const owner = ownerOf(authUser, headers[DEVICE_ID_HEADER])
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const find = async () =>
        (
          await agentJobViews(conversation.id, await listAgentMessages(conversation.id, owner))
        ).find((job) => job.result.job?.taskId === params.taskId)
      // 先确认它是这个会话里某次调用提交的后台任务：会话里别的任务（对话轮自己）不归这里取消。
      if (!(await find())) return status(404, NOT_FOUND)
      await cancelAgentJob(conversation.id, params.taskId)
      const job = await find()
      if (!job) return status(404, NOT_FOUND)
      const response: AgentBackgroundJobCancelResponse = { job }
      return response
    },
    {
      params: t.Object({ id: t.String(), taskId: t.String() }),
      headers: deviceIdHeaderSchema(),
    },
  )
  .post(
    // 单张重试：按失败卡起跑时的参数快照重出一张，不经对话模型。它不跟轮，不必转发到跑着轮的实例；
    // 重试记录的落库与在跑那一轮的写入由消息表的会话锁串行。同一个占位上已有重试在跑就原样给回它。
    '/api/agent/conversations/:id/retries',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const outcome = await retryAgentToolCall({
        conversationId: conversation.id,
        messageId: body.messageId,
        ...(body.placeholderId ? { placeholderId: body.placeholderId } : {}),
        deviceId: body.deviceId,
        userId: authUser?.id ?? null,
      })
      if (outcome.kind === 'not_found') return status(404, { error: 'message_not_found' })
      if (outcome.kind === 'not_retryable') return status(422, { error: 'not_retryable' })
      if (outcome.kind === 'refused') {
        const refused: AgentRetryRefusedBody = { error: 'retry_refused', code: outcome.code }
        return status(409, refused)
      }
      const response: AgentRetryResponse = { message: outcome.message }
      return response
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema(),
        messageId: t.String({ minLength: 1, maxLength: 128 }),
        placeholderId: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
      }),
    },
  )
  .post(
    // 中止一条还在跑的重试，按原桶退回。
    '/api/agent/conversations/:id/retries/:messageId/cancel',
    async ({ params, body, authUser, status }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      const outcome = await cancelAgentRetry(conversation.id, params.messageId)
      if (outcome === 'not_found') return status(404, { error: 'retry_not_found' })
      if (outcome === 'finished') return status(409, { error: 'retry_finished' })
      return { cancelled: true }
    },
    {
      params: t.Object({ id: t.String(), messageId: t.String() }),
      body: t.Object({ deviceId: deviceIdSchema() }),
    },
  )
  .post(
    // 确认一张待确认的生成卡：按用户最后改过的提示词与拟稿时冻结的材料提交，不再经过模型。
    // 它不跟轮（那一轮早已结束），所以不必转发到跑着轮的实例；同一张卡的并发确认由卡片级的
    // 咨询锁串行，只会有一条任务。
    '/api/agent/conversations/:id/confirmations',
    async ({ params, body, authUser, status }) => {
      const owner = ownerOf(authUser, body.deviceId)
      const conversation = await findAgentConversation(params.id, owner)
      if (!conversation) return status(404, NOT_FOUND)
      const outcome = await confirmAgentGeneration({
        conversationId: conversation.id,
        owner,
        messageId: body.messageId,
        prompt: body.prompt,
        deviceId: body.deviceId,
        userId: authUser?.id ?? null,
      })
      if (outcome.kind === 'not_found') return status(404, { error: 'message_not_found' })
      if (outcome.kind === 'not_confirmable') return status(422, { error: 'not_confirmable' })
      if (outcome.kind === 'refused') {
        const refused: AgentConfirmationRefusedBody = {
          error: 'confirmation_refused',
          code: outcome.code,
        }
        return status(409, refused)
      }
      const response: AgentConfirmationResponse = { message: outcome.message }
      return response
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema(),
        messageId: t.String({ minLength: 1, maxLength: 128 }),
        // 空白与超长由确认本身按 `confirmation_refused` 回绝（界面只认 code）；这里只挡住
        // 明显的滥用体积。
        prompt: t.String({ maxLength: 20_000 }),
      }),
    },
  )
  .post(
    // 用户在保存卡片上按下了保存：记录已经落在他自己的浏览器里（素材库是本机的东西），
    // 这里只把卡改写成已保存，并往收件箱里放一条话，智能体下一轮接着往下说。
    // 那条话要进正在跑的那一轮的事件流与排队列表，所以与发消息走同一条转发。
    '/api/agent/conversations/:id/saves',
    async ({ params, body, authUser, status, request }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      const outcome = await markAgentSaveCardSaved({
        conversationId: conversation.id,
        toolCallId: body.toolCallId,
        kind: body.kind,
        recordId: body.recordId,
        name: body.name,
        deviceId: body.deviceId,
      })
      if (outcome.kind === 'not_found') return status(404, { error: 'message_not_found' })
      if (outcome.kind === 'not_savable') return status(422, { error: 'not_savable' })
      if (outcome.kind === 'saved' && outcome.queued) {
        // 排进去的那句话得有人取：会话闲着就当场开轮，忙着就等这一轮收尾（与发消息同一条路）。
        if (runningTurn(conversation.id))
          notifyConversation(conversation.id, { type: 'messageQueued', message: outcome.queued })
        else
          void drainConversationInbox(conversation.id).catch((err) =>
            log.error(
              { event: 'agent.inbox_drain_failed', conversationId: conversation.id, err },
              'save notice could not start a turn',
            ),
          )
      }
      const response: AgentSaveResponse = { message: outcome.message }
      return response
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        deviceId: deviceIdSchema(),
        toolCallId: t.String({ minLength: 1, maxLength: 128 }),
        kind: t.Union([t.Literal('asset'), t.Literal('look')]),
        recordId: t.String({ minLength: 1, maxLength: 128 }),
        name: t.String({ minLength: 1, maxLength: SYNC_NAME_MAX_LENGTH }),
      }),
    },
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

        const references = turnReferences(body.references ?? [])
        if (!references) return status(422, { error: 'invalid_reference' })
        try {
          await validateSelections(references)
        } catch (error) {
          if (error instanceof InvalidSelectionError)
            return status(422, { error: 'invalid_selection' })
          throw error
        }
        // 按 id 附来的图先认领：认领不上就是越权或图已经不在，这一轮还没开始，打回最便宜。
        if (!(await claimConversationMedia(conversation.id, authUser?.id ?? null, references)))
          return status(422, { error: 'invalid_reference' })
        // 开不了轮的请求不进收件箱：排进去也没有哪一轮能取走它。
        if (isCapabilityEnabled('billing:credits') && owner.kind !== 'user')
          return status(401, { error: 'unauthorized' })
        if (bffDrain.status().draining) return status(503, { error: 'instance_draining' })

        // 每条消息先进收件箱，再按顺序开轮：忙时它排在后面，闲时它当场就是下一条。
        const enqueued = await enqueueAgentUserMessage(conversation.id, {
          clientMessageId: body.clientMessageId ?? crypto.randomUUID(),
          text: body.text,
          references,
          deviceId: body.deviceId,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.params ? { params: body.params } : {}),
          ...(body.clarificationAnswer ? { clarificationAnswer: true } : {}),
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
        /** 这是对澄清卡片的答复：排在其他排队消息前面处理。 */
        clarificationAnswer: t.Optional(t.Boolean()),
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
  .post(
    // 把一条排队消息升级为插话：进正在跑的那一轮，在它下一个动作边界生效，不再等这一轮结束。
    '/api/agent/conversations/:id/queue/:queueId/interject',
    async ({ params, body, authUser, status, request }) => {
      const conversation = await findAgentConversation(params.id, ownerOf(authUser, body.deviceId))
      if (!conversation) return status(404, NOT_FOUND)
      // 插话只能进本进程里跑着的那一轮。
      const forwarded = await forwardActiveTurn(conversation.id, request, body)
      if (forwarded) return forwarded
      const reply = (result: AgentQueueInterjectResult, turnId?: string) =>
        turnId ? { result, turnId } : { result }
      const active = runningTurn(conversation.id)
      if (!active) {
        const entry = await agentInboxEntry(conversation.id, params.queueId)
        if (!entry) return reply('not_found')
        if (entry.state === 'pending') return reply('not_running')
        return reply(entry.state === 'consumed' ? 'already_consumed' : 'cancelled')
      }
      const pending = await pendingAgentMessage(conversation.id, params.queueId)
      if (pending.kind === 'unavailable') return reply(pending.result)
      const { message } = pending
      // 参考图校验与归档要花几秒：这期间它仍然排着，到真正进这一轮的前一刻才取走。
      let claimed = false
      const claim = () =>
        claimForTurn(active.turnId, async () => {
          claimed = await claimAgentMessageForInterjection(
            conversation.id,
            message.id,
            active.turnId,
          )
          return claimed
        })
      // 取走之后才插不进去的那种（本轮刚好收尾）：取走之后的每一步都已同步写进这一轮，抛错
      // 也是插进去之后的事，所以只有明确返回 null 才放回。
      const messageId = await active.interject(message.text, message.references, {
        messageId: message.id,
        claim,
      })
      if (!messageId) {
        if (claimed) {
          await requeueAgentMessage(conversation.id, message.id, active.turnId)
          // 放回去的时候那一轮可能已经放手了：没人会再来取，这里接着开轮。按了停止的不开——
          // 停止等着这一步落定，随后把它和别的排队消息一起退回。
          if (!turnStopping(active.turnId) && !runningTurn(conversation.id))
            void drainConversationInbox(conversation.id).catch((err) =>
              log.error(
                { event: 'agent.inbox_drain_failed', conversationId: conversation.id, err },
                'queued agent message could not start a turn',
              ),
            )
          return reply('not_running')
        }
        // 没取到：它此刻的状态就是结局（被停止退回、被撤回、被起轮取走，或者仍排着）。
        const entry = await agentInboxEntry(conversation.id, message.id)
        if (!entry) return reply('not_found')
        if (entry.state === 'pending') return reply('not_running')
        return reply(entry.state === 'consumed' ? 'already_consumed' : 'cancelled')
      }
      await settleAgentInterjection(conversation.id, message.id)
      notifyConversation(conversation.id, {
        type: 'queuedMessageInterjected',
        queueId: message.id,
        turnId: active.turnId,
      })
      return reply('interjected', active.turnId)
    },
    {
      params: t.Object({ id: t.String(), queueId: t.String({ maxLength: 128 }) }),
      body: t.Object({ deviceId: deviceIdSchema() }),
    },
  )
  .get(
    // 输入框打 `/` 时的候选，也是模板页的清单。只有名字与「何时用」：正文是给模型读的，
    // 不是给这个弹层读的；预置模板另带封面与钉死的参数，那几项只给界面。
    '/api/agent/skills',
    async ({ query, authUser }) => {
      // 动态引入：`skills` 与 `tools` 静态依赖 pi，模块图不该因为一条清单端点被提到路由加载时。
      const [{ listAgentSkillSummaries, ensureAgentSkills }, { resolveAgentMode }] =
        await Promise.all([import('../lib/agent/skills'), import('../lib/agent/tools')])
      await ensureAgentSkills()
      // 做不了视频的部署里没有视频轮，所以也没有只有视频轮看得见的技能。
      return {
        skills: await listAgentSkillSummaries(
          resolveAgentMode(query.mode ?? 'image'),
          authUser?.id ?? null,
        ),
      }
    },
    { query: t.Object({ mode: modeSchema }) },
  )
  .get(
    // 预置模板的封面与参考图。图片随技能目录发布，所以取法也跟着技能走：认技能名与文件名，
    // 路径守卫与读正文那一路同一份。不认证——这些字节随镜像发给所有人，本来就不是谁的私物。
    '/api/agent/skills/:name/files/:file',
    async ({ params, query, status }) => {
      const [{ readAgentSkillFileBytes, ensureAgentSkills }, { resolveAgentMode }] =
        await Promise.all([import('../lib/agent/skills'), import('../lib/agent/tools')])
      await ensureAgentSkills()
      const result = await readAgentSkillFileBytes(
        resolveAgentMode(query.mode ?? 'image'),
        params.name,
        params.file,
      )
      if (result.kind !== 'ok') return status(404, { error: 'skill_file_not_found' })
      return new Response(result.bytes, {
        headers: {
          'content-type': result.contentType,
          // 随镜像发的静态字节：同一个部署里它不会变，变了也是换了一版镜像。
          'cache-control': 'public, max-age=3600, immutable',
        },
      })
    },
    {
      params: t.Object({
        name: t.String({ maxLength: 128 }),
        file: t.String({ maxLength: 128 }),
      }),
      query: t.Object({ mode: modeSchema }),
    },
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
        if (await conversationBusy(conversation.id))
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
        // 删除与确认生成走同一把会话锁：确认不会把任务建进一个刚删掉的会话，
        // 墓碑与取消也同一次提交，没有「删完又冒出一条任务」的缝。
        await db.transaction(async (tx) => {
          await lockConversation(tx, conversation.id, owner.kind === 'user' ? owner.userId : null)
          await softDeleteAgentConversation(conversation.id, owner, tx)
          // 删掉的会话不该接着花钱：没结束的后台任务一并取消，按原桶退回。
          await cancelAgentConversationJobs(conversation.id, tx)
        })
        // 字节在事务之外清：删对象不可回滚，放进事务只会让「墓碑已提交、对象删失败」
        // 变成「整笔回滚但对象已经没了」。两个前缀都清——参考图按会话存，
        // 草稿输入图按草稿存，会话没了两者都再没有读路径。
        await removeAgentConversationReferences(conversation.id)
        await discardConversationDraftInputs(conversation.id)
        return { ok: true }
      })
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ deviceId: deviceIdSchema() }) },
  )
  .post(
    '/api/agent/conversations/adopt',
    // 领养是不可逆的：会话改挂到账号下，原设备再也看不到。所以这一个动作不接受
    // 「自述设备标识」，要求这个浏览器持有起轮时下发的那张 cookie。知道标识不等于持有它。
    async ({ body, authUser, status, cookie }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!(await holdsDeviceClaim(body.deviceId, cookie as CookieJar)))
        return status(403, { error: 'device_claim_required' })
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
      if (!activeTurn) {
        // 这一轮已经停下：多半是上一次停止的响应丢了、客户端在重发。那次退回的排队消息仍然
        // 交还，不能因为服务端已经撤掉就两头落空。
        const returned = await returnedAgentMessages(conversation.id, params.turnId)
        if (returned.length === 0) return status(404, TURN_NOT_FOUND)
        const aborted: AgentTurnAbortedBody = { aborted: true, returned }
        return aborted
      }
      // 先让在路上的插话升级落定，再退回排队消息，最后中止：这一轮收尾时队里已经空了，不会
      // 接着开下一轮。退回的交给客户端放回输入框，由用户决定改了再发还是删掉。
      await beginTurnStop(activeTurn)
      const { returned, fresh } = await returnAgentMessages(conversation.id, activeTurn.turnId)
      for (const queueId of fresh)
        notifyConversation(conversation.id, { type: 'queuedMessageWithdrawn', queueId })
      activeTurn.abort()
      const aborted: AgentTurnAbortedBody = { aborted: true, returned }
      return aborted
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
      const references = turnReferences(body.references ?? [])
      if (!references) return status(422, { error: 'invalid_reference' })
      if (!(await claimConversationMedia(conversation.id, authUser?.id ?? null, references)))
        return status(422, { error: 'invalid_reference' })
      let messageId: string | null
      try {
        messageId = await activeTurn.interject(body.text, references)
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
