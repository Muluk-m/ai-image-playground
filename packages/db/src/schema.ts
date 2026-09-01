import type { PersistedSubmitRequest, QueueProvider, TaskStatus } from '@image-playground/shared'
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
    submitted_at: epochMs('submitted_at').notNull(),
    started_at: epochMs('started_at'),
    completed_at: epochMs('completed_at'),
    user_id: text('user_id').references(() => users.id),
    client_request_id: text('client_request_id'),
    attempt_count: integer('attempt_count').notNull().default(0),
    upstream_invocation_count: integer('upstream_invocation_count').notNull().default(0),
    next_retry_at: epochMs('next_retry_at'),
    device_id: text('device_id').generatedAlwaysAs(sql`request_payload ->> 'device_id'`),
  },
  (t) => [
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
