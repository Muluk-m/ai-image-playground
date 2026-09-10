import type {
  AgentCompactionRecord,
  AgentContentBlock,
  AgentMessageRole,
  AgentTurnEvent,
  PersistedSubmitRequest,
  QueueProvider,
  TaskKind,
  TaskStatus,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export type UserStatus = 'active' | 'disabled'

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
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    last_login_at: epochMs('last_login_at'),
  },
  (t) => [
    uniqueIndex('idx_users_username').on(t.username),
    check('users_status_check', sql`${t.status} IN ('active', 'disabled')`),
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
    /** 图片本体的内容哈希，同时是对象键 `users/<user_id>/assets/<image_id>` 的末段。 */
    image_id: text('image_id'),
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
    title: text('title').notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    deleted_at: epochMs('deleted_at'),
    /** 上下文压缩的私有状态：摘要、锚点、折叠次数与熔断计数。不下发前端。 */
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

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<QueueProvider>().notNull(),
    model: text('model').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    request_payload: bunJsonb('request_payload').$type<PersistedSubmitRequest>().notNull(),
    result_payload: bunJsonb('result_payload'),
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
    /** `chat` 的行 worker 不碰、后台不展示；它只是让每笔积分占用挂得住的那个任务。 */
    kind: text('kind').$type<TaskKind>().notNull().default('queue'),
  },
  (t) => [
    check('tasks_kind_check', sql`${t.kind} IN ('queue', 'chat')`),
    index('idx_tasks_status').on(t.status),
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
export type UserPreferencesRow = typeof user_preferences.$inferSelect
export type UserAssetObjectRow = typeof user_asset_objects.$inferSelect
export type AgentConversationRow = typeof agent_conversations.$inferSelect
export type AgentMessageRow = typeof agent_messages.$inferSelect
export type AgentTurnEventRow = typeof agent_turn_events.$inferSelect
