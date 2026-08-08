import type { QueueProvider, SubmitRequest, TaskStatus } from '@image-playground/shared'
import { desc, sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export type UserStatus = 'active' | 'disabled'

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    password_hash: text('password_hash').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    last_login_at: integer('last_login_at'),
  },
  (t) => ({
    usernameUnique: uniqueIndex('idx_users_username').on(t.username),
  }),
)

export const user_sessions = sqliteTable(
  'user_sessions',
  {
    /** 浏览器只持有原 token；数据库只存 SHA-256，避免数据库泄漏直接变成登录态。 */
    token_hash: text('token_hash').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at').notNull(),
  },
  (t) => ({
    userIdx: index('idx_user_sessions_user_id').on(t.user_id),
    expiryIdx: index('idx_user_sessions_expires_at').on(t.expires_at),
  }),
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<QueueProvider>().notNull(),
    model: text('model').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    request_payload: text('request_payload', { mode: 'json' }).$type<SubmitRequest>().notNull(),
    result_payload: text('result_payload', { mode: 'json' }),
    error_message: text('error_message'),
    error_type: text('error_type'),
    submitted_at: integer('submitted_at').notNull(),
    started_at: integer('started_at'),
    completed_at: integer('completed_at'),
    /** 商业部署的账号归属。老任务和未开启认证的个人部署保持 NULL。 */
    user_id: text('user_id').references(() => users.id),
    /** 客户端幂等键。NULL 表示老任务或客户端没传；前端新提交一律会带。 */
    client_request_id: text('client_request_id'),
    /**
     * 已尝试次数（含首次）。新任务=0；worker 失败决定重试时在已 in_progress
     * 行上 +1（即将变成第 N 次重试时写 N，然后 status 回退到 'queued'）。
     */
    attempt_count: integer('attempt_count').notNull().default(0),
    /**
     * 下次允许重试的时间戳。仅在 status='queued' 且 attempt_count>0 时有值——
     * 表示这条 queued 是「等待重试」状态而非「初次未起跑」。worker claim 必须
     * `next_retry_at IS NULL OR next_retry_at <= now`，避免未到时被错误启动。
     */
    next_retry_at: integer('next_retry_at'),
  },
  (t) => ({
    anonymousRequestUnique: uniqueIndex('idx_tasks_anonymous_client_request_id')
      .on(t.client_request_id)
      .where(sql`${t.user_id} IS NULL AND ${t.client_request_id} IS NOT NULL`),
    userRequestUnique: uniqueIndex('idx_tasks_user_client_request_id')
      .on(t.user_id, t.client_request_id)
      .where(sql`${t.user_id} IS NOT NULL AND ${t.client_request_id} IS NOT NULL`),
    userTimeIdx: index('idx_tasks_user_time')
      .on(t.user_id, desc(t.submitted_at))
      .where(sql`${t.user_id} IS NOT NULL`),
  }),
)

export const daily_quota = sqliteTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: text('date').notNull(), // 'YYYY-MM-DD' UTC
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.device_id, t.date] }),
  }),
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserSession = typeof user_sessions.$inferSelect
