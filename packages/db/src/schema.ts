import type {
  AgentCompactionRecord,
  AgentContentBlock,
  AgentMessageRole,
  AgentMode,
  AgentQueuedMessageFailure,
  AgentQueuedMessageState,
  AgentToolCallSnapshot,
  AgentTurnCost,
  AgentTurnEvent,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnStopReason,
  AgentTurnUsage,
  ChannelMedia,
  GenerationParameters,
  GenerationSource,
  GenerationSummary,
  PersistedSubmitRequest,
  ProjectDocument,
  ProjectReceipt,
  QueueProvider,
  TaskErrorType,
  TaskKind,
  TaskStatus,
  VideoGenerationRecord,
} from '@image-playground/shared'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  pgView,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export type UserStatus = 'active' | 'disabled'

/** Stored in users.password_hash until an OAuth-only account sets a password. */
export const OAUTH_ONLY_PASSWORD_HASH = 'oauth-only-account'

/**
 * HTTP and queue contracts use Unix epoch milliseconds. PostgreSQL stores timestamptz so expiry,
 * retention, and operational queries remain timezone-safe.
 */
const epochMs = customType<{ data: number; driverData: string }>({
  dataType: () => 'timestamp with time zone',
  toDriver: (value) => new Date(value).toISOString(),
  fromDriver: (value) => new Date(value).getTime(),
})
/**
 * Bun SQL accepts and returns JSON values as objects. Drizzle's built-in pg jsonb mapper serializes
 * values first, which would store a JSON string instead of a JSON object with this driver.
 */
const bunJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => value,
  fromDriver: (value) => value,
})

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    password_hash: text('password_hash').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    email_verified_at: epochMs('email_verified_at'),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    last_login_at: epochMs('last_login_at'),
  },
  (t) => [
    uniqueIndex('idx_users_username').on(t.username),
    check('users_status_check', sql`${t.status} IN ('active', 'disabled')`),
  ],
)

export const admin_user_notes = pgTable('admin_user_notes', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

export const email_verification_codes = pgTable(
  'email_verification_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    code_hash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    created_at: epochMs('created_at').notNull(),
    expires_at: epochMs('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_email_verification_codes_email').on(t.email),
    index('idx_email_verification_codes_expires_at').on(t.expires_at),
  ],
)

export const user_sessions = pgTable(
  'user_sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: epochMs('created_at').notNull(),
    expires_at: epochMs('expires_at').notNull(),
  },
  (t) => [
    index('idx_user_sessions_user_id').on(t.user_id),
    index('idx_user_sessions_expires_at').on(t.expires_at),
  ],
)

/**
 * OAuth identities are additive: a subject never merges into an existing password account,
 * so a leaked provider email cannot take over one.
 */
export const user_identities = pgTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    display_name: text('display_name'),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_user_identities_provider_subject').on(t.provider, t.subject),
    index('idx_user_identities_user_id').on(t.user_id),
  ],
)

export const operator_audits = pgTable(
  'operator_audits',
  {
    id: text('id').primaryKey(),
    operator_id: text('operator_id').notNull(),
    action: text('action').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    details: bunJsonb('details').$type<Record<string, unknown>>().notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    index('idx_operator_audits_target').on(t.target_type, t.target_id, t.created_at.desc()),
    index('idx_operator_audits_created_at').on(t.created_at.desc()),
  ],
)

export type InspirationKind = 'showcase' | 'template' | 'skill'
export type InspirationStatus = 'draft' | 'published' | 'archived'
export interface InspirationParams {
  size: string
  quality?: 'auto' | 'low' | 'medium' | 'high'
  n?: number
}
export interface InspirationReferenceImage {
  key: string
  name: string
}

export const inspiration_categories = pgTable('inspiration_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sort: integer('sort').notNull().default(0),
  created_at: epochMs('created_at').notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

export const inspiration_items = pgTable(
  'inspiration_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<InspirationKind>().notNull(),
    status: text('status').$type<InspirationStatus>().notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    title: text('title').notNull(),
    description: text('description'),
    category_id: text('category_id')
      .notNull()
      .references(() => inspiration_categories.id),
    prompt: text('prompt').notNull(),
    recommended_provider: text('recommended_provider').notNull(),
    recommended_model: text('recommended_model').notNull(),
    params: bunJsonb('params').$type<InspirationParams>().notNull(),
    tags: bunJsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    cover_key: text('cover_key').notNull(),
    image_key: text('image_key'),
    reference_images: bunJsonb('reference_images')
      .$type<InspirationReferenceImage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    skill_name: text('skill_name'),
    source_url: text('source_url'),
    author: text('author'),
    sort: integer('sort').notNull().default(0),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    updated_by: text('updated_by').notNull(),
    published_at: epochMs('published_at'),
  },
  (t) => [
    index('idx_inspiration_items_public').on(t.status, t.sort, t.id),
    index('idx_inspiration_items_category').on(t.category_id, t.sort, t.id),
    check('inspiration_items_kind_check', sql`${t.kind} IN ('showcase', 'template', 'skill')`),
    check('inspiration_items_status_check', sql`${t.status} IN ('draft', 'published', 'archived')`),
  ],
)

export const inspiration_publications = pgTable('inspiration_publications', {
  version: integer('version').primaryKey(),
  published_at: epochMs('published_at').notNull(),
  item_count: integer('item_count').notNull(),
  manifest_hash: text('manifest_hash').notNull(),
})

/**
 * 同步记录的通用列。删除以墓碑传播：`deleted_at` 非空的行内容列全为空，客户端读路径按它过滤。
 * `version` 是落库那一刻的每用户版本号，拉取即「取版本号大于客户端持有值的行」。
 */
const syncRecordColumns = {
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  updated_at: epochMs('updated_at').notNull(),
  last_used_at: epochMs('last_used_at'),
  deleted_at: epochMs('deleted_at'),
  version: integer('version').notNull(),
}

export const user_templates = pgTable(
  'user_templates',
  {
    ...syncRecordColumns,
    name: text('name'),
    prompt: text('prompt'),
    asset_ids: bunJsonb('asset_ids').$type<Array<string | null>>(),
    params: bunJsonb('params').$type<Record<string, unknown>>(),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_templates_user_version').on(t.user_id, t.version),
    check(
      'user_templates_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.prompt} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

export const user_assets = pgTable(
  'user_assets',
  {
    ...syncRecordColumns,
    name: text('name'),
    /**
     * 封面视角图片本体的内容哈希，同时是对象键 `users/<user_id>/assets/<image_id>` 的末段。
     * `views` 之前的客户端只读这一列，所以它始终等于 `views[0].imageId`。
     */
    image_id: text('image_id'),
    /** 产品或人物；`views` 之前建的素材没有类别。 */
    kind: text('kind'),
    /** 透明或纯色。 */
    background: text('background'),
    /** 有序视角 `[{ imageId, label, source }]`，第一条是封面。旧行为 null，读路径按封面补一条。 */
    views: bunJsonb('views').$type<Array<{ imageId: string; label: string; source: string }>>(),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_assets_user_version').on(t.user_id, t.version),
    check(
      'user_assets_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.image_id} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

/**
 * 模板（代码里叫 `look`，旧「模板」占着 `user_templates`）：一份技能正文加它钉死的模型、尺寸、
 * 素材位数量与图片。参考图与封面走素材图同一条上传路径，计入同一项素材图配额。
 */
export const user_looks = pgTable(
  'user_looks',
  {
    ...syncRecordColumns,
    name: text('name'),
    /** 一句话描述。它进这个用户每一轮的技能清单，必须是一行人话。 */
    description: text('description'),
    purpose: text('purpose'),
    /** frontmatter 之后的分节正文，就是技能正文。 */
    body: text('body'),
    model: text('model'),
    size: text('size'),
    slot_count: integer('slot_count'),
    reference_image_ids: bunJsonb('reference_image_ids').$type<string[]>(),
    cover_image_id: text('cover_image_id'),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_looks_user_version').on(t.user_id, t.version),
    check(
      'user_looks_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.description} IS NOT NULL AND ${t.body} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

/** 用户设置整份存取，不做字段级合并。 */
export const user_preferences = pgTable('user_preferences', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  document: bunJsonb('document').$type<Record<string, unknown>>().notNull(),
  updated_at: epochMs('updated_at').notNull(),
  version: integer('version').notNull(),
})

/**
 * 已上传的素材图本体台账。对象键是 `users/<user_id>/assets/<image_id>`，这张表既是「对象在不在」
 * 的判据（同步接受素材记录的前提），也是每用户素材总字节的来源——对象存储自己数不出来。
 */
export const user_asset_objects = pgTable(
  'user_asset_objects',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    image_id: text('image_id').notNull(),
    bytes: integer('bytes').notNull(),
    content_type: text('content_type').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.image_id] })],
)

/** 每用户单调递增的同步版本号；推送时锁住这一行，同一用户的并发同步因此串行。 */
export const user_sync_state = pgTable('user_sync_state', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(0),
})

export const canvas_projects = pgTable(
  'canvas_projects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    revision: integer('revision').notNull(),
    document: bunJsonb('document').$type<ProjectDocument>().notNull(),
    element_count: integer('element_count').notNull(),
    cover_media_id: text('cover_media_id'),
    conversation_id: text('conversation_id').references(() => agent_conversations.id, {
      onDelete: 'set null',
    }),
    receipts: bunJsonb('receipts').$type<ProjectReceipt[]>().notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    deleted_at: epochMs('deleted_at'),
    restore_until: epochMs('restore_until'),
  },
  (t) => [
    index('idx_canvas_projects_owner_id').on(t.user_id, t.id),
    uniqueIndex('idx_canvas_projects_conversation').on(t.conversation_id),
  ],
)

/**
 * 匿名设备的持有性证明，只为「领养」这一个动作存在。
 *
 * 设备标识全程由客户端自述，知道它就能读它的会话——这是既有模型，本表不改它。改的是
 * 领养：它把「读」升级成了「永久占有」（会话改挂到账号下，原设备再也看不到），所以这一个
 * 动作要求浏览器证明自己**持有**这个设备标识，而不只是知道它。
 *
 * 首次见到某个设备标识时登记一行，同时下发 HttpOnly cookie。**已登记的设备不再改绑**：
 * 一个从日志或分享链接里泄漏出去的设备标识，换个浏览器拿不到证明，也就领养不走。
 */
export const agent_device_claims = pgTable('agent_device_claims', {
  device_id: text('device_id').primaryKey(),
  token_hash: text('token_hash').notNull(),
  created_at: epochMs('created_at').notNull(),
})

/**
 * 智能体会话。归属 `user_id` 或 `device_id`，二者互斥：设备登录后会话改挂到用户。
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
  readonly wake?: Pick<AgentInboxTaskResultPayload, 'turnId' | 'taskIds'>
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
    /** 除提示词以外的整份请求，输入图与遮罩已归档成对象引用，绝不在库里留 base64。 */
    request: bunJsonb('request').$type<PersistedSubmitRequest>().notNull(),
    submission: bunJsonb('submission').$type<AgentDraftSubmission>().notNull(),
    created_at: epochMs('created_at').notNull(),
    /** 确认提交出的任务；非空即这份草稿已经用掉，再确认只交回同一张卡。 */
    task_id: text('task_id'),
    confirmed_at: epochMs('confirmed_at'),
  },
  (t) => [
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

export const deployment_controls = pgTable('deployment_controls', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
})

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
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.turn_id] }),
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

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<QueueProvider>().notNull(),
    model: text('model').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    request_payload: bunJsonb('request_payload').$type<PersistedSubmitRequest>().notNull(),
    result_payload: bunJsonb('result_payload'),
    /** Recoverable source URLs or spooled object references; never inline original bytes. */
    archive_payload: bunJsonb('archive_payload'),
    /** First durable archive checkpoint; bounds save retries without consuming model attempts. */
    archive_retry_started_at: epochMs('archive_retry_started_at'),
    error_message: text('error_message'),
    error_type: text('error_type'),
    /**
     * Terminal upstream HTTP failures keep their status for operator triage. Transport failures and
     * application timeouts have no HTTP response and therefore remain null.
     */
    upstream_status: integer('upstream_status'),
    /**
     * Truncated upstream error response body. This preserves diagnostic codes that are not present
     * in the normalized error message without allowing unbounded responses into the task row.
     */
    upstream_body: text('upstream_body'),
    /**
     * Upstream async image task ids. A single task row owns several when the requested image
     * count is fanned out. Non-null means the upstream work is already paid for: recovery must
     * resume polling instead of resubmitting.
     */
    upstream_task_ids: bunJsonb('upstream_task_ids').$type<string[]>(),
    /** Anchor for the polling deadline, so a restart cannot grant a fresh timeout budget. */
    upstream_submitted_at: epochMs('upstream_submitted_at'),
    execution_token: text('execution_token'),
    lease_expires_at: epochMs('lease_expires_at'),
    submitted_at: epochMs('submitted_at').notNull(),
    started_at: epochMs('started_at'),
    completed_at: epochMs('completed_at'),
    user_id: text('user_id').references(() => users.id),
    client_request_id: text('client_request_id'),
    attempt_count: integer('attempt_count').notNull().default(0),
    upstream_invocation_count: integer('upstream_invocation_count').notNull().default(0),
    next_retry_at: epochMs('next_retry_at'),
    device_id: text('device_id').generatedAlwaysAs(sql`request_payload ->> 'device_id'`),
    /** 智能体工具提交的任务带上会话与轮；用户自己提交的任务两列都是 null。 */
    agent_conversation_id: text('agent_conversation_id'),
    agent_turn_id: text('agent_turn_id'),
    kind: text('kind').$type<TaskKind>().notNull().default('queue'),
  },
  (t) => [
    check('tasks_kind_check', sql`${t.kind} IN ('queue', 'chat')`),
    index('idx_tasks_status').on(t.status),
    index('idx_tasks_queued_provider_time')
      .on(t.provider, t.submitted_at, t.id)
      .where(sql`${t.status} = 'queued'`),
    index('idx_tasks_queued_provider_eligible')
      .on(
        t.provider,
        sql`greatest(${t.submitted_at}, coalesce(${t.next_retry_at}, ${t.submitted_at}))`,
        t.id,
      )
      .where(sql`${t.status} = 'queued'`),
    index('idx_tasks_lease_expires').on(t.lease_expires_at).where(sql`${t.status} = 'in_progress'`),
    index('idx_tasks_submitted_at').on(t.submitted_at),
    index('idx_tasks_next_retry_at').on(t.next_retry_at).where(sql`${t.next_retry_at} IS NOT NULL`),
    uniqueIndex('idx_tasks_anonymous_client_request_id')
      .on(t.client_request_id)
      .where(sql`${t.user_id} IS NULL AND ${t.client_request_id} IS NOT NULL`),
    uniqueIndex('idx_tasks_user_client_request_id')
      .on(t.user_id, t.client_request_id)
      .where(sql`${t.user_id} IS NOT NULL AND ${t.client_request_id} IS NOT NULL`),
    index('idx_tasks_user_time')
      .on(t.user_id, t.submitted_at.desc())
      .where(sql`${t.user_id} IS NOT NULL`),
    // Admin 用户详情按状态筛选时看全量历史，没有时间窗兜底；缺这条索引会退化成扫该用户全部任务。
    index('idx_tasks_user_status_time')
      .on(t.user_id, t.status, t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.user_id} IS NOT NULL`),
    index('idx_tasks_agent_turn')
      .on(t.agent_conversation_id, t.agent_turn_id)
      .where(sql`${t.agent_turn_id} IS NOT NULL`),
    index('idx_tasks_admin_device_time').on(
      t.device_id,
      t.submitted_at.desc(),
      t.id.desc(),
      t.status,
      t.model,
    ),
  ],
)

export const daily_quota = pgTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.device_id, t.date] })],
)

/**
 * 后台与队列端点读这张视图，不读 `tasks`：对话轮的可见性靠这一层挡，不靠每条查询自觉。
 * 真要看对话轮，显式写 `tasks`。
 */
// Archive recovery sources and executor fencing are worker-private and are not part of the
// operational view. Keeping them out also preserves the committed view shape across additive
// task migrations, so existing read-only grants do not need the view to be dropped and recreated.
const {
  archive_payload: _archivePayload,
  archive_retry_started_at: _archiveRetryStartedAt,
  execution_token: _executionToken,
  lease_expires_at: _leaseExpiresAt,
  ...queueTaskColumns
} = getTableColumns(tasks)
export const queue_tasks = pgView('queue_tasks').as((qb) =>
  qb.select(queueTaskColumns).from(tasks).where(eq(tasks.kind, 'queue')),
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserSession = typeof user_sessions.$inferSelect
export type UserIdentity = typeof user_identities.$inferSelect
export type NewUserIdentity = typeof user_identities.$inferInsert
export type OperatorAudit = typeof operator_audits.$inferSelect
export type NewOperatorAudit = typeof operator_audits.$inferInsert
export type UserTemplateRow = typeof user_templates.$inferSelect
export type UserAssetRow = typeof user_assets.$inferSelect
export type UserLookRow = typeof user_looks.$inferSelect
export type UserPreferencesRow = typeof user_preferences.$inferSelect
export type UserAssetObjectRow = typeof user_asset_objects.$inferSelect
export type AgentConversationRow = typeof agent_conversations.$inferSelect
export type AgentMessageRow = typeof agent_messages.$inferSelect
export type AgentGenerationDraftRow = typeof agent_generation_drafts.$inferSelect
export type AgentTurnEventRow = typeof agent_turn_events.$inferSelect
export type AgentTurnRow = typeof agent_turns.$inferSelect

/** Short-lived encrypted cross-origin handoff; source browser retains its original data. */
export const domain_migrations = pgTable('domain_migrations', {
  id: text('id').primaryKey(),
  proof_hash: text('proof_hash').notNull(),
  upload_hash: text('upload_hash').notNull(),
  source_session_hash: text('source_session_hash'),
  source_user_id: text('source_user_id'),
  created_at: epochMs('created_at').notNull(),
  expires_at: epochMs('expires_at').notNull(),
  chunks: integer('chunks').notNull().default(0),
  bytes: integer('bytes').notNull().default(0),
  sealed: integer('sealed').notNull().default(0),
})

export const domain_migration_chunks = pgTable(
  'domain_migration_chunks',
  {
    migration_id: text('migration_id')
      .notNull()
      .references(() => domain_migrations.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    ciphertext: text('ciphertext').notNull(),
  },
  (t) => [primaryKey({ columns: [t.migration_id, t.sequence] })],
)

export const generation_records = pgTable(
  'generation_records',
  {
    source: bunJsonb('source').$type<GenerationSource>(),
    /** 用户删除作品只隐藏记录；媒体对象可能还被画布或别的记录引用，不跟着删。 */
    deleted_at: epochMs('deleted_at'),
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    archive_status: text('archive_status')
      .$type<GenerationSummary['archiveStatus']>()
      .notNull()
      .default('none'),
    error_type: text('error_type').$type<TaskErrorType>(),
    prompt: text('prompt').notNull(),
    parameters: bunJsonb('parameters')
      .$type<GenerationParameters>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actual_parameters: bunJsonb('actual_parameters')
      .$type<GenerationParameters>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created_at: epochMs('created_at').notNull(),
    started_at: epochMs('started_at'),
    completed_at: epochMs('completed_at'),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    index('idx_generation_records_owner_time').on(t.user_id, t.created_at.desc(), t.id.desc()),
  ],
)

export const project_generation_outputs = pgTable(
  'project_generation_outputs',
  {
    generation_id: text('generation_id')
      .notNull()
      .references(() => generation_records.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => canvas_projects.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').notNull(),
    turn_id: text('turn_id').notNull(),
    object_id: text('object_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.generation_id, t.position] }),
    uniqueIndex('idx_project_generation_objects').on(t.project_id, t.object_id),
  ],
)

export const user_change_heads = pgTable('user_change_heads', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull().default(0n),
})

export const user_changes = pgTable(
  'user_changes',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
    changes: bunJsonb('changes')
      .$type<
        Array<{ entity: 'generation'; id: string } | { entity: 'generation'; invalidate: true }>
      >()
      .notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.sequence] })],
)

export const generation_commands = pgTable(
  'generation_commands',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    command_id: text('command_id').notNull(),
    request_hash: text('request_hash').notNull(),
    task_id: text('task_id').notNull(),
    submitted_at: epochMs('submitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.command_id] })],
)

/**
 * 服务进程定期留下的「我还在，我是哪个版本」。运维看板据此判断死活与线上版本，不去探测端口。
 * 每个实例一行、原地更新；重新部署会换实例，旧实例的行由 worker 的维护循环清掉。
 */
export const service_heartbeats = pgTable(
  'service_heartbeats',
  {
    service: text('service').notNull(),
    instance: text('instance').notNull(),
    version: text('version').notNull(),
    last_seen_at: epochMs('last_seen_at').notNull(),
    /** 服务自述的附加状态，例如 worker 最后一次成功轮询队列的时间。 */
    detail: bunJsonb('detail').$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.service, t.instance] }),
    index('idx_service_heartbeats_seen').on(t.service, t.last_seen_at.desc()),
  ],
)

/**
 * 宿主机资源的一次读数。按时间成序列、只留近几天，用来看趋势而不只是当前值。
 * 由采集容器经后端内部接口写入；同一台宿主机上的每套部署各存各的一份。
 */
export const host_samples = pgTable('host_samples', {
  sampled_at: epochMs('sampled_at').primaryKey(),
  disk_total_bytes: bigint('disk_total_bytes', { mode: 'number' }).notNull(),
  disk_available_bytes: bigint('disk_available_bytes', { mode: 'number' }).notNull(),
  mem_total_bytes: bigint('mem_total_bytes', { mode: 'number' }).notNull(),
  mem_available_bytes: bigint('mem_available_bytes', { mode: 'number' }).notNull(),
  // 后加的几列：旧采集容器报上来的读数没有它们，所以都可空。
  cpu_count: integer('cpu_count'),
  cpu_busy_ratio: doublePrecision('cpu_busy_ratio'),
  load_1: doublePrecision('load_1'),
  load_5: doublePrecision('load_5'),
  load_15: doublePrecision('load_15'),
  swap_total_bytes: bigint('swap_total_bytes', { mode: 'number' }),
  swap_free_bytes: bigint('swap_free_bytes', { mode: 'number' }),
  booted_at: epochMs('booted_at'),
})

/**
 * 同一次宿主机采样里各容器的资源读数，来自宿主机的 cgroup。和 `host_samples` 一样只留近几天。
 * 同一台宿主机上的每套部署各存各的一份，看到的都是整台机器上的全部容器。
 */
export const container_samples = pgTable(
  'container_samples',
  {
    sampled_at: epochMs('sampled_at').notNull(),
    container_id: text('container_id').notNull(),
    name: text('name'),
    mem_bytes: bigint('mem_bytes', { mode: 'number' }).notNull(),
    mem_limit_bytes: bigint('mem_limit_bytes', { mode: 'number' }),
    cpu_cores: doublePrecision('cpu_cores'),
    oom_kills: integer('oom_kills').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sampled_at, t.container_id] })],
)

/**
 * 后端每个实例每分钟一行的接口统计。只统计 API 请求，不含静态资源与健康检查。
 * 延迟量的是处理到响应发出为止，流式响应的传输时长不算在内。
 */
export const api_minutes = pgTable(
  'api_minutes',
  {
    minute: epochMs('minute').notNull(),
    instance: text('instance').notNull(),
    requests: integer('requests').notNull(),
    client_errors: integer('client_errors').notNull(),
    server_errors: integer('server_errors').notNull(),
    p50_ms: integer('p50_ms'),
    p95_ms: integer('p95_ms'),
    max_ms: integer('max_ms'),
    /** 这一分钟里返回 5xx 的路由与次数，形如 `{"POST /v1/queue/:provider/:model/submit": 3}`。 */
    server_error_routes: bunJsonb('server_error_routes').$type<Record<string, number>>(),
  },
  (t) => [primaryKey({ columns: [t.minute, t.instance] })],
)

export const media_objects = pgTable(
  'media_objects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    content_type: text('content_type').notNull(),
    status: text('status').$type<'pending' | 'ready'>().notNull(),
    reserved_bytes: bigint('reserved_bytes', { mode: 'number' }).notNull(),
    staging_key: text('staging_key').notNull(),
    object_key: text('object_key'),
    preview_key: text('preview_key'),
    preview_bytes: bigint('preview_bytes', { mode: 'number' }).notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    expires_at: epochMs('expires_at').notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_media_objects_owner_hash').on(t.user_id, t.sha256),
    index('idx_media_objects_pending').on(t.status, t.expires_at),
    check('media_objects_bytes_check', sql`${t.bytes} > 0`),
    check('media_objects_reserved_bytes_check', sql`${t.reserved_bytes} >= 0`),
    check('media_objects_status_check', sql`${t.status} IN ('pending', 'ready')`),
  ],
)

export const media_references = pgTable(
  'media_references',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    media_id: text('media_id')
      .notNull()
      .references(() => media_objects.id, { onDelete: 'restrict' }),
    owner_kind: text('owner_kind')
      .$type<'project' | 'asset' | 'conversation' | 'generation'>()
      .notNull(),
    owner_id: text('owner_id').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.owner_kind, t.owner_id, t.media_id] }),
    index('idx_media_references_media').on(t.media_id),
    check(
      'media_references_owner_kind_check',
      sql`${t.owner_kind} IN ('project', 'asset', 'conversation', 'generation')`,
    ),
  ],
)

export const generation_images = pgTable(
  'generation_images',
  {
    generation_id: text('generation_id')
      .notNull()
      .references(() => generation_records.id, { onDelete: 'cascade' }),
    role: text('role').$type<'input' | 'mask' | 'output'>().notNull(),
    position: integer('position').notNull(),
    media_id: text('media_id')
      .notNull()
      .references(() => media_objects.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.generation_id, t.role, t.position] }),
    check('generation_images_role_check', sql`${t.role} IN ('input', 'mask', 'output')`),
  ],
)
