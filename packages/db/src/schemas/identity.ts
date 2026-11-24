import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { epochMs } from './common'

export type UserStatus = 'active' | 'disabled'

/** Stored in users.password_hash until an OAuth-only account sets a password. */
export const OAUTH_ONLY_PASSWORD_HASH = 'oauth-only-account'

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
    /** 展示名。登录名仍是 username。空着表示还没设置。 */
    nickname: text('nickname'),
    /** 个人简介。空着表示没有简介。 */
    bio: text('bio'),
    /** 对象存储里的头像键。空着时接口返回默认芽标，不把默认图写进这一列。 */
    avatar_key: text('avatar_key'),
  },
  (t) => [
    uniqueIndex('idx_users_username').on(t.username),
    index('idx_users_status_created').on(t.status, t.created_at.desc(), t.id.desc()),
    index('idx_users_last_login')
      .on(t.last_login_at.desc(), t.id.desc())
      .where(sql`${t.last_login_at} IS NOT NULL`),
    check('users_status_check', sql`${t.status} IN ('active', 'disabled')`),
    check(
      'users_nickname_check',
      sql`${t.nickname} IS NULL OR (char_length(${t.nickname}) BETWEEN 2 AND 20 AND ${t.nickname} = btrim(${t.nickname}))`,
    ),
    check(
      'users_bio_check',
      sql`${t.bio} IS NULL OR (char_length(${t.bio}) BETWEEN 1 AND 120 AND ${t.bio} = btrim(${t.bio}))`,
    ),
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

export const password_reset_tokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    created_at: epochMs('created_at').notNull(),
    expires_at: epochMs('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_password_reset_tokens_hash').on(t.token_hash),
    index('idx_password_reset_tokens_user').on(t.user_id),
    index('idx_password_reset_tokens_expires_at').on(t.expires_at),
  ],
)

/**
 * 一条网页登录链。access 行在 `user_sessions`，refresh 只在这里存哈希。
 * 轮换时旧 refresh 哈希进 `user_retired_refresh_tokens`，用于拒绝旧凭据和确认幂等重试。
 * `created_at` 是登录时间，绝对上限从它算；`refresh_expires_at` 每次刷新滑动。
 */
export const user_session_families = pgTable(
  'user_session_families',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refresh_token_hash: text('refresh_token_hash').notNull(),
    created_at: epochMs('created_at').notNull(),
    refreshed_at: epochMs('refreshed_at').notNull(),
    refresh_expires_at: epochMs('refresh_expires_at').notNull(),
    absolute_expires_at: epochMs('absolute_expires_at').notNull(),
    revoked_at: epochMs('revoked_at'),
    revoke_reason: text('revoke_reason'),
    user_agent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    uniqueIndex('idx_user_session_families_refresh_token_hash').on(t.refresh_token_hash),
    index('idx_user_session_families_user_id').on(t.user_id),
  ],
)

/** 已轮换的网页 refresh 哈希。精确幂等请求可恢复当前结果，其余旧凭据拒绝认证。 */
export const user_retired_refresh_tokens = pgTable(
  'user_retired_refresh_tokens',
  {
    token_hash: text('token_hash').primaryKey(),
    family_id: text('family_id')
      .notNull()
      .references(() => user_session_families.id, { onDelete: 'cascade' }),
    retired_at: epochMs('retired_at').notNull(),
    request_key_hash: text('request_key_hash'),
  },
  (t) => [
    index('idx_user_retired_refresh_tokens_family').on(t.family_id),
    uniqueIndex('idx_user_retired_refresh_request').on(t.family_id, t.request_key_hash),
  ],
)

export const user_sessions = pgTable(
  'user_sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * 空表示部署前的旧会话：在原来的 expires_at 之前仍然有效，下次刷新再挂到链上。
     * 删链不会级联删掉这些行。
     */
    family_id: text('family_id').references(() => user_session_families.id, {
      onDelete: 'cascade',
    }),
    created_at: epochMs('created_at').notNull(),
    expires_at: epochMs('expires_at').notNull(),
    /** 签发时的 User-Agent，之后随活动刷新。 */
    user_agent: text('user_agent'),
    /** 签发时的客户端地址，之后随活动刷新。 */
    ip: text('ip'),
    /** 最近一次带着这枚会话访问的时间。旧行可能为空，读取时回退到 created_at。 */
    last_active_at: epochMs('last_active_at'),
  },
  (t) => [
    index('idx_user_sessions_user_id').on(t.user_id),
    index('idx_user_sessions_expires_at').on(t.expires_at),
    index('idx_user_sessions_family_id').on(t.family_id),
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

export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied' | 'consumed'

/** Public OAuth clients allowed to start a device authorization (seeded by migration). */
export const oauth_clients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  created_at: epochMs('created_at').notNull(),
})

/** RFC 8628 device authorizations. Only hashes of the device and user codes are stored. */
export const device_authorizations = pgTable(
  'device_authorizations',
  {
    id: text('id').primaryKey(),
    client_id: text('client_id')
      .notNull()
      .references(() => oauth_clients.id, { onDelete: 'cascade' }),
    device_code_hash: text('device_code_hash').notNull(),
    user_code_hash: text('user_code_hash').notNull(),
    status: text('status').$type<DeviceAuthorizationStatus>().notNull().default('pending'),
    scopes: text('scopes').notNull(),
    user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expires_at: epochMs('expires_at').notNull(),
    interval_seconds: integer('interval_seconds').notNull(),
    last_polled_at: epochMs('last_polled_at'),
    created_at: epochMs('created_at').notNull(),
    /** Loopback sign-in: where the approval page sends the one-time code, and its PKCE challenge. */
    redirect_uri: text('redirect_uri'),
    code_challenge: text('code_challenge'),
    authorization_code_hash: text('authorization_code_hash'),
    authorization_code_expires_at: epochMs('authorization_code_expires_at'),
  },
  (t) => [
    uniqueIndex('idx_device_authorizations_device_code_hash').on(t.device_code_hash),
    uniqueIndex('idx_device_authorizations_authorization_code_hash').on(t.authorization_code_hash),
    uniqueIndex('idx_device_authorizations_user_code_hash').on(t.user_code_hash),
    index('idx_device_authorizations_expires_at').on(t.expires_at),
    check(
      'device_authorizations_status_check',
      sql`${t.status} IN ('pending', 'approved', 'denied', 'consumed')`,
    ),
  ],
)

/**
 * One row per CLI connection (a token family). Refreshing rotates the hashes in place; the
 * retired refresh hashes live in `cli_retired_refresh_tokens` for replay detection and recovery.
 */
export const cli_connections = pgTable(
  'cli_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => oauth_clients.id, { onDelete: 'cascade' }),
    scopes: text('scopes').notNull(),
    access_token_hash: text('access_token_hash').notNull(),
    access_expires_at: epochMs('access_expires_at').notNull(),
    refresh_token_hash: text('refresh_token_hash').notNull(),
    refresh_expires_at: epochMs('refresh_expires_at').notNull(),
    created_at: epochMs('created_at').notNull(),
    last_used_at: epochMs('last_used_at'),
    /** 签发与活跃请求时的 User-Agent（含 CLI 版本与 OS/架构），旧连接可为空。 */
    user_agent: text('user_agent'),
    revoked_at: epochMs('revoked_at'),
  },
  (t) => [
    uniqueIndex('idx_cli_connections_access_token_hash').on(t.access_token_hash),
    uniqueIndex('idx_cli_connections_refresh_token_hash').on(t.refresh_token_hash),
    index('idx_cli_connections_user_id').on(t.user_id),
  ],
)

export const cli_retired_refresh_tokens = pgTable(
  'cli_retired_refresh_tokens',
  {
    token_hash: text('token_hash').primaryKey(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => cli_connections.id, { onDelete: 'cascade' }),
    /** SHA-256 of the CLI's refresh request identity; NULL for keyless (older) clients. */
    request_key_hash: text('request_key_hash'),
    retired_at: epochMs('retired_at').notNull(),
  },
  (t) => [
    index('idx_cli_retired_refresh_tokens_connection').on(t.connection_id),
    uniqueIndex('idx_cli_retired_refresh_request').on(t.connection_id, t.request_key_hash),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserSession = typeof user_sessions.$inferSelect
export type UserIdentity = typeof user_identities.$inferSelect
export type NewUserIdentity = typeof user_identities.$inferInsert
