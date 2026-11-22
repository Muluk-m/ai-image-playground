import type {
  AgentCanvasSnapshot,
  AgentCompactionRecord,
  AgentContentBlock,
  AgentMessageRole,
  AgentMode,
  AgentQueuedMessageFailure,
  AgentQueuedMessageState,
  AgentToolCallSnapshot,
  AgentTurnCost,
  AgentTurnEvent,
  AgentTurnFailure,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnStopReason,
  AgentTurnUsage,
  ChannelMedia,
  PersistedSubmitRequest,
  ProductionGenerationBinding,
  ProductionGenerationReference,
  ProductionRecord,
  QueueProvider,
  VideoGenerationRecord,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs } from './common'
import { users } from './identity'

/**
 * 智能体会话。归属 `user_id` 或 `device_id`，由创建时的身份决定。
 * 删除以墓碑传播，`deleted_at` 非空的会话从读路径消失。
 */
export const agent_conversations = pgTable(
  'agent_conversations',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    device_id: text('device_id'),
    runtime_generation: integer('runtime_generation').notNull().default(0),
    title: text('title').notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    deleted_at: epochMs('deleted_at'),
    /** 上下文压缩的私有状态：摘要、锚点与熔断计数。不下发前端。 */
    compaction: bunJsonb('compaction').$type<AgentCompactionRecord>(),
    production: bunJsonb('production').$type<ProductionRecord>(),
  },
  (t) => [
    check(
      'agent_conversations_owner_check',
      sql`(${t.user_id} IS NULL) <> (${t.device_id} IS NULL)`,
    ),
    index('idx_agent_conversations_user_time')
      .on(t.user_id, t.updated_at.desc())
      .where(sql`${t.user_id} IS NOT NULL`),
    index('idx_agent_conversations_device_time')
      .on(t.device_id, t.updated_at.desc())
      .where(sql`${t.device_id} IS NOT NULL`),
    unique('agent_conversations_owner_id_key').on(t.user_id, t.id),
  ],
)

/**
 * 会话里的消息。`seq` 是会话内单调递增的读回顺序。存储里的消息一条不改：
 * 上下文压缩只塑造送给模型的输入，不回写这张表。
 */
export const agent_messages = pgTable(
  'agent_messages',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    turn_id: text('turn_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').$type<AgentMessageRole>().notNull(),
    content: bunJsonb('content').$type<AgentContentBlock[]>().notNull(),
    created_at: epochMs('created_at').notNull(),
    deleted_at: epochMs('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.id] }),
    uniqueIndex('idx_agent_messages_conversation_seq').on(t.conversation_id, t.seq),
    index('idx_agent_messages_turn').on(t.conversation_id, t.turn_id),
    // 确认门还等着确认的卡（见 BFF `tool-gate-records.ts`）：发新消息时在会话锁里找它们。
    index('idx_agent_messages_pending_gate')
      .on(t.conversation_id)
      .where(
        sql`${t.deleted_at} IS NULL AND ${t.content} @> '[{"type":"toolResult","status":"awaiting_confirmation","gated":true}]'::jsonb`,
      ),
    check('agent_messages_role_check', sql`${t.role} IN ('user', 'assistant')`),
  ],
)

/**
 * 工具调用起跑那一刻模型选定的参数，一次调用一行，起跑就落库。结果卡要等工具跑完才写进
 * `agent_messages`，事件日志又有保留窗口；轮在工具半截丢了（实例崩溃），续跑与重试只能从这里
 * 找回当时的参数。`message_id` 就是这次调用那张结果卡的消息 id。
 */
export const agent_tool_calls = pgTable(
  'agent_tool_calls',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    message_id: text('message_id').notNull(),
    turn_id: text('turn_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    tool_name: text('tool_name').notNull(),
    snapshot: bunJsonb('snapshot').$type<AgentToolCallSnapshot>().notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.message_id] }),
    index('idx_agent_tool_calls_turn').on(t.conversation_id, t.turn_id),
  ],
)

/** 收件箱里一条用户消息的载荷：起轮要的全部输入，除了参考图的字节（见 `attachments`）。 */
export interface AgentInboxUserMessagePayload {
  readonly text: string
  readonly deviceId: string
  readonly mode?: AgentMode
  readonly params?: AgentTurnParams
  readonly referenceCount: number
  /** 对澄清卡片的答复；`kind` 为 `clarification_answer` 的记录才有。 */
  readonly clarificationAnswer?: true
  /** 发话时浏览器里的画布。缺席即这一轮只认服务端已经同步的那份。 */
  readonly canvas?: AgentCanvasSnapshot
  /** 发话时客户端看到的入口。项目文档记下入口之前，起轮按它判定，缺席才看有没有带画布。 */
  readonly experience?: 'chat' | 'canvas'
  /** 发话时的模式（Agent 或画布），决定这一轮的工具；缺席按 Agent 模式。 */
  readonly surface?: 'agent' | 'canvas'
}

/**
 * 收件箱里一条唤醒的载荷：同一次提交（`turnId` 那一轮）里该让智能体回来看的那几个后台任务。
 * 失败的一律在列，成功的只有提交时选了复核的才在列。
 */
export interface AgentInboxTaskResultPayload {
  readonly turnId: string
  readonly taskIds: readonly string[]
  /** 唤醒轮替谁计日配额：提交这些任务的那台设备。 */
  readonly deviceId: string
  /** One immutable, completed batch version; its items are summarized without loading pixels. */
  readonly batch?: {
    readonly batchId: string
    readonly version: number
    readonly eventVersion: 1
    readonly itemKeys: readonly string[]
  }
  /** 一批阶段授权运行的回报（画布节点运行）；摘要从授权上的回报读，不在这里。 */
  readonly stageRun?: {
    readonly authorizationId: string
    readonly eventVersion: 1
  }
}

/**
 * 收件箱里一条中断续跑的载荷（`kind` 为 `system_event`）：`interruptedTurnId` 那一轮被服务重启或
 * 执行者接管打断了，要再起一轮接着做。创作类型、参数与计日配额的设备沿用被打断的那一轮。
 */
export interface AgentInboxResumePayload {
  readonly interruptedTurnId: string
  readonly deviceId: string
  readonly mode?: AgentMode
  readonly params?: AgentTurnParams
  /**
   * 被打断的是一轮唤醒：它当时要处理的那一批（提交它们的轮与任务）。续跑照这一批接着处理，
   * 授权原文、改图计划与要复核的产物都沿用提交那一轮的，不把用户更早的请求重做一遍。
   */
  readonly wake?: Pick<AgentInboxTaskResultPayload, 'turnId' | 'taskIds' | 'batch' | 'stageRun'>
  /** 被打断那一轮发话时的画布。续跑仍认它，不退回当时还没同步完的服务端文档。 */
  readonly canvas?: AgentCanvasSnapshot
  /**
   * 不是被打断，而是被确认门拦下（`interruptedTurnId` 即被拦下的那一轮）：用户把那一轮拦下的卡
   * 都确认了，续跑接着那几次工具调用往下走，不给模型额外的说明（见 BFF `tool-gate.ts`）。
   */
  readonly gate?: true
}

export type AgentInboxPayload =
  | AgentInboxUserMessagePayload
  | AgentInboxTaskResultPayload
  | AgentInboxResumePayload

/**
 * 会话收件箱：智能体还没取走的东西。忙时用户发的话排在这里，按 `seq` 在当前回复可以结束时
 * 取，每轮一条。`status` 从 `pending` 走向 `consumed` 或 `cancelled`，两条路由同一条记录上的
 * 原子更新裁决，撤回与处理只有一个成立。轮到时开不了轮的那一条走向 `failed`，`failure` 记下
 * 错误码，不再挡后面的；用户撤掉它时才变成 `cancelled`。`client_message_id` 让网络重发的同一条消息不排两次。
 * `attachments` 是参考图原件，只在待处理时留着，取走或撤回就清掉。
 */
export const agent_inbox = pgTable(
  'agent_inbox',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind')
      .$type<'user_message' | 'clarification_answer' | 'task_result' | 'system_event'>()
      .notNull(),
    status: text('status').$type<AgentQueuedMessageState>().notNull(),
    client_message_id: text('client_message_id'),
    payload: bunJsonb('payload').$type<AgentInboxPayload>().notNull(),
    attachments: bunJsonb('attachments').$type<AgentTurnReference[]>(),
    consumed_turn_id: text('consumed_turn_id'),
    failure: text('failure').$type<AgentQueuedMessageFailure>(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.id] }),
    uniqueIndex('idx_agent_inbox_conversation_seq').on(t.conversation_id, t.seq),
    uniqueIndex('idx_agent_inbox_client_message')
      .on(t.conversation_id, t.client_message_id)
      .where(sql`${t.client_message_id} IS NOT NULL`),
    index('idx_agent_inbox_pending')
      .on(t.conversation_id, t.seq)
      .where(sql`${t.status} = 'pending'`),
    // 唤醒与续跑按消费轮次往回追发起消息（见 `lib/agent/experience.ts`）。
    index('idx_agent_inbox_consumed_turn')
      .on(t.conversation_id, t.consumed_turn_id)
      .where(sql`${t.status} = 'consumed'`),
    check(
      'agent_inbox_kind_check',
      sql`${t.kind} IN ('user_message', 'clarification_answer', 'task_result', 'system_event')`,
    ),
    check(
      'agent_inbox_status_check',
      sql`${t.status} IN ('pending', 'consumed', 'cancelled', 'failed')`,
    ),
  ],
)

/**
 * 提交那一刻智能体的改图计划：授权原文、是否遮罩轮、已提交的内容身份与还没执行的后续编辑。
 * 唤醒轮接着这份计划走，不另起一份（见 bff 的 `masked-plan.ts`）。
 */
export interface AgentJobPlan {
  readonly authorization: string
  readonly protected: boolean
  readonly contents: readonly string[]
  readonly deferred: readonly string[]
}

/**
 * 后台任务登记：智能体工具提交的每个生成任务一行，与任务行在同一个事务里写下，记着智能体提交时
 * 「成功后要不要回来复核」的选择。执行归任务表，唤醒投递归这里：worker 写终态的同一个事务里
 * 判断这一批（同一轮提交的那些）能不能唤醒，`delivered_at` 让一批只投递一次；`wake_id` 是它
 * 随之进了哪一条收件箱记录，没有唤醒（成功且没选复核、被取消）时为空。
 */
export const agent_jobs = pgTable(
  'agent_jobs',
  {
    task_id: text('task_id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    wake_on_success: boolean('wake_on_success').notNull().default(false),
    plan: bunJsonb('plan').$type<AgentJobPlan>(),
    submitted_at: epochMs('submitted_at').notNull(),
    delivered_at: epochMs('delivered_at'),
    wake_id: text('wake_id'),
  },
  (t) => [
    index('idx_agent_jobs_undelivered')
      .on(t.conversation_id, t.turn_id)
      .where(sql`${t.delivered_at} IS NULL`),
  ],
)

/**
 * 一张待确认的生成卡背后、服务端替它记着的那一份提交材料：确认时照它原样提交，不再回头问模型。
 * `anchor_object_id` 是产出要贴着放的画布对象，`review` 是提交那一刻定下的复核选择，
 * `plan` 是提交那一刻的改图计划（唤醒轮接着它走）。视频档位记在 `video_record` 里，
 * 结果卡与产物照它标注。
 */
export interface AgentDraftSubmission {
  readonly production?: ProductionGenerationBinding
  readonly productionDraftRevision?: number
  readonly productionParams?: AgentTurnParams
  readonly productionReferences?: readonly ProductionGenerationReference[]
  readonly productionOperationId?: string
  readonly productionFingerprint?: string
  readonly anchorObjectId?: string
  readonly review: boolean
  readonly plan?: AgentJobPlan
  readonly videoRecord?: VideoGenerationRecord
}

/**
 * 待用户确认的生成草稿：工具把整份请求准备好（提示词、输入图、遮罩、模型、档位）却不提交，
 * 材料落在这里，用户在卡上改完提示词点「确认生成」才真正建任务。付费只发生在确认那一步，
 * 所以这张表里的一行不花一分钱。
 *
 * `id` 一物三用：输入图在对象存储里的前缀、提交时的幂等命令 id、以及行本身的标识。进程在
 * 建完任务、还没写回 `task_id` 时死掉，下一次确认按这个命令 id 找得到那条任务并认领它，
 * 不会再提交、再扣一次费。`(conversation_id, turn_id, tool_call_id)` 唯一：一次工具调用只
 * 拟一份稿，确认端点从结果卡上的这三位找回它。
 */
export const agent_generation_drafts = pgTable(
  'agent_generation_drafts',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    tool_name: text('tool_name').notNull(),
    media: text('media').$type<ChannelMedia>().notNull(),
    provider: text('provider').$type<QueueProvider>().notNull(),
    model: text('model').notNull(),
    /** 拟好的提示词；确认时由用户改过的那一份覆盖，两份都要能看见提交的是哪一句。 */
    prompt: text('prompt').notNull(),
    drafted_prompt: text('drafted_prompt'),
    /** 除提示词以外的整份请求，输入图与遮罩已归档成对象引用，绝不在库里留 base64。 */
    request: bunJsonb('request').$type<PersistedSubmitRequest>().notNull(),
    submission: bunJsonb('submission').$type<AgentDraftSubmission>().notNull(),
    created_at: epochMs('created_at').notNull(),
    /** 确认提交出的任务；非空即这份草稿已经用掉，再确认只交回同一张卡。 */
    task_id: text('task_id'),
    confirmed_at: epochMs('confirmed_at'),
  },
  (t) => [
    index('idx_agent_generation_drafts_created').on(t.created_at.desc(), t.id.desc()),
    // Admin 按任务反查草稿、提示词列表排除已有草稿的任务都按 task_id 查；只有确认过的草稿才有它。
    index('idx_agent_generation_drafts_task').on(t.task_id).where(sql`${t.task_id} IS NOT NULL`),
    uniqueIndex('idx_agent_generation_drafts_call').on(
      t.conversation_id,
      t.turn_id,
      t.tool_call_id,
    ),
  ],
)

/** `seq` 是会话内单调递增的事件序号，也就是 SSE 的 `id`。行有保留窗口，过期会被清掉。 */
export const agent_turn_events = pgTable(
  'agent_turn_events',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    turn_id: text('turn_id').notNull(),
    event: bunJsonb('event').$type<AgentTurnEvent>().notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.seq] }),
    index('idx_agent_turn_events_turn').on(t.conversation_id, t.turn_id, t.seq),
    index('idx_agent_turn_events_created').on(t.created_at),
  ],
)

export const agent_executions = pgTable(
  'agent_executions',
  {
    conversation_id: text('conversation_id')
      .primaryKey()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    instance: text('instance').notNull(),
    origin: text('origin').notNull(),
    state: text('state').$type<'running' | 'completed' | 'failed'>().notNull(),
    heartbeat_at: epochMs('heartbeat_at').notNull(),
  },
  (t) => [
    check('agent_executions_state_check', sql`${t.state} IN ('running', 'completed', 'failed')`),
  ],
)

/**
 * 每轮的持久事实：耗时、停因与结算后的消耗。翻历史时的页脚读这张表，不读轮事件——
 * 事件是为断线续播存的，有 24 小时保留窗口；这张表跟着会话活，会话删了才跟着删。
 */
export const agent_turns = pgTable(
  'agent_turns',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    stop_reason: text('stop_reason').$type<AgentTurnStopReason>().notNull(),
    /** 结算后的实际消耗；不计费的部署里是 null，那里的页脚只有耗时。 */
    cost: bunJsonb('cost').$type<AgentTurnCost>(),
    failure: bunJsonb('failure').$type<AgentTurnFailure>(),
    /**
     * 这一轮结束后建议用户接着发的完整句子。null 是还没问，或这一轮不该问
     * （失败、中止、澄清、待确认都留着 null）。空数组是问过但没有可用的句子，
     * 或整段对话都没有用户原话。只问一次。页脚重写不碰这一列。
     */
    follow_ups: bunJsonb('follow_ups').$type<readonly string[]>(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.turn_id] }),
    // 运营概览按时间窗统计轮次与活跃主体；轮次随会话长期保留，没有它每次都要扫全表。
    index('idx_agent_turns_created').on(t.created_at),
    check(
      'agent_turns_stop_reason_check',
      sql`${t.stop_reason} IN ('completed', 'aborted', 'failed')`,
    ),
  ],
)

/** 每次模型请求的独立用量；摘要由平台承担，不混入对话任务结算。 */
export const agent_model_calls = pgTable(
  'agent_model_calls',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    user_id: text('user_id'),
    device_id: text('device_id').notNull(),
    purpose: text('purpose')
      .$type<'conversation' | 'compaction' | 'handoff' | 'web_search'>()
      .notNull(),
    model: text('model').notNull(),
    input_image_count: integer('input_image_count').notNull().default(0),
    // Null marks legacy calls whose dispatch facts were not recorded.
    http_dispatch_count: integer('http_dispatch_count'),
    request_bytes: bigint('request_bytes', { mode: 'number' }),
    local_rejection: text('local_rejection'),
    status: text('status').$type<'in_progress' | 'completed' | 'failed' | 'cancelled'>().notNull(),
    usage: bunJsonb('usage').$type<AgentTurnUsage>(),
    cache_read_tokens: integer('cache_read_tokens'),
    cache_write_tokens: integer('cache_write_tokens'),
    tool_calls: bunJsonb('tool_calls').$type<{ id: string; name: string }[]>(),
    started_at: epochMs('started_at').notNull(),
    finished_at: epochMs('finished_at'),
  },
  (t) => [
    index('idx_agent_model_calls_turn').on(t.conversation_id, t.turn_id),
    index('idx_agent_model_calls_started_at').on(t.started_at),
    check(
      'agent_model_calls_purpose_check',
      sql`${t.purpose} IN ('conversation', 'compaction', 'handoff', 'web_search')`,
    ),
    check(
      'agent_model_calls_status_check',
      sql`${t.status} IN ('in_progress', 'completed', 'failed', 'cancelled')`,
    ),
  ],
)

export type AgentConversationRow = typeof agent_conversations.$inferSelect
export type AgentMessageRow = typeof agent_messages.$inferSelect
export type AgentGenerationDraftRow = typeof agent_generation_drafts.$inferSelect
export type AgentTurnEventRow = typeof agent_turn_events.$inferSelect
export type AgentTurnRow = typeof agent_turns.$inferSelect
