import type { AgentModelSettings } from '@image-playground/shared'
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
} from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs } from './common'

export const agent_model_settings = pgTable('agent_model_settings', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  settings: bunJsonb('settings').$type<AgentModelSettings>().notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

/**
 * 后台保存的上游 API key。只存 AES-256-GCM 密文，不存明文、末几位或指纹。
 * 主密钥来自环境变量；解不开时调用方回退到环境变量里的 key。
 */
export const upstream_api_secrets = pgTable('upstream_api_secrets', {
  id: text('id').primaryKey(),
  nonce: text('nonce').notNull(),
  tag: text('tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  updated_at: epochMs('updated_at').notNull(),
  updated_by: text('updated_by').notNull(),
})

/** 系统替运营下架模型的原因；运营手动下架不写原因。 */
export type ModelPauseReason = 'upstream_unavailable'

/**
 * 运营停用的模型。没有行即上架：新接入的模型不用先登记一行才能用。
 * 页面的模型列表、智能体可用的模型与提交前的拦截都只认这一张表；单价归收费模块，不在这里。
 */
export const model_availability = pgTable('model_availability', {
  model: text('model').primaryKey(),
  active: boolean('active').notNull(),
  /** 有值即系统自动暂停（上游没有可用账号），等运营补上容量后手动恢复。 */
  pause_reason: text('pause_reason').$type<ModelPauseReason>(),
  paused_at: epochMs('paused_at'),
  updated_at: epochMs('updated_at').notNull(),
})

/**
 * 上游调度桶的状态。上限（每分钟张数、同时在途数）来自本环境配置，不存表；这一行是 worker 们抢额度时
 * 加 FOR UPDATE 的锁点，另外记着遇到 429 后的冷却截止时间。没有行即从未用过，首次抢额度时补上。
 */
export const scheduler_buckets = pgTable('scheduler_buckets', {
  key: text('key').primaryKey(),
  cooldown_until: epochMs('cooldown_until'),
  updated_at: epochMs('updated_at').notNull(),
})

/**
 * 一次上游请求在一个桶上占的额度。同一请求可能同时占几个桶（每模型张数 + 同时在途数），
 * 在同一事务里一起拿到。`released_at` 为空即仍在途；心跳停了的租约由下一次抢额度时回收。
 * 按 `acquired_at` 落在最近一分钟内的行计算每分钟张数，所以释放后的行留到滑出窗口才删。
 */
export const scheduler_leases = pgTable(
  'scheduler_leases',
  {
    attempt_id: text('attempt_id').notNull(),
    bucket_key: text('bucket_key').notNull(),
    images: integer('images').notNull(),
    worker_id: text('worker_id').notNull(),
    acquired_at: epochMs('acquired_at').notNull(),
    heartbeat_at: epochMs('heartbeat_at').notNull(),
    released_at: epochMs('released_at'),
  },
  (t) => [
    primaryKey({ columns: [t.attempt_id, t.bucket_key] }),
    index('idx_scheduler_leases_bucket_acquired').on(t.bucket_key, t.acquired_at),
  ],
)

/**
 * OpenAI 直连每条请求的成本，按月累计做预算封顶（apps/bff/src/lib/upstream/gpt-budget.ts）。
 * 上游回了 usage 按 token 折算；没回（中断、超时）按档位估算并标 `estimated`。
 */
export const gpt_direct_usage = pgTable(
  'gpt_direct_usage',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id'),
    model: text('model').notNull(),
    size: text('size'),
    quality: text('quality'),
    images: integer('images').notNull(),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    cost_micro_usd: bigint('cost_micro_usd', { mode: 'number' }).notNull(),
    estimated: boolean('estimated').notNull(),
    /** HMAC-SHA256 前 8 位。空的是多密钥上线前的旧行，算进当前第一把 key。 */
    key_fingerprint: text('key_fingerprint'),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    index('idx_gpt_direct_usage_created').on(t.created_at),
    index('idx_gpt_direct_usage_key_created').on(t.key_fingerprint, t.created_at),
  ],
)

/**
 * 一把 OpenAI 直连密钥的跨 worker 状态。不存密钥，只存指纹。
 * `disabled_reason` 为空表示没有被停用；冷却看 `cooldown_until`。预算用满不写在这里。
 */
export const gpt_direct_key_state = pgTable(
  'gpt_direct_key_state',
  {
    fingerprint: text('fingerprint').primaryKey(),
    disabled_reason: text('disabled_reason').$type<'quota' | 'invalid' | null>(),
    cooldown_until: epochMs('cooldown_until'),
    last_error: text('last_error'),
    last_error_at: epochMs('last_error_at'),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    check(
      'gpt_direct_key_state_reason_check',
      sql`${t.disabled_reason} IS NULL OR ${t.disabled_reason} IN ('quota', 'invalid')`,
    ),
  ],
)

/**
 * 后台配置的 OpenAI 直连密钥。密文字段与 upstream_api_secrets 相同，用同一把主密钥。
 * 没有行时直连退回环境变量。明文不进这张表。
 */
export const gpt_direct_admin_keys = pgTable(
  'gpt_direct_admin_keys',
  {
    id: text('id').primaryKey(),
    ordinal: integer('ordinal').notNull(),
    /** HMAC-SHA256 前 8 位。不存明文。 */
    fingerprint: text('fingerprint').notNull(),
    budget_usd: integer('budget_usd').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nonce: text('nonce').notNull(),
    tag: text('tag').notNull(),
    ciphertext: text('ciphertext').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    updated_by: text('updated_by').notNull(),
  },
  (t) => [
    unique('gpt_direct_admin_keys_fingerprint_key').on(t.fingerprint),
    // 迁移里这条是 DEFERRABLE INITIALLY DEFERRED（drizzle 无法表达），重排顺序时同一事务内逐行改 ordinal 靠它。
    unique('gpt_direct_admin_keys_ordinal_key').on(t.ordinal),
    check('gpt_direct_admin_keys_ordinal_check', sql`${t.ordinal} > 0`),
    check('gpt_direct_admin_keys_budget_check', sql`${t.budget_usd} > 0`),
  ],
)

/**
 * 选中一把直连 key 时预占的估算额度。请求结束要么计入 usage 并删掉，要么直接释放。
 * 和 usage 一起算进月封顶，避免多个 worker 同时读到同一余额。
 */
export const gpt_direct_budget_holds = pgTable(
  'gpt_direct_budget_holds',
  {
    id: text('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    month_start: epochMs('month_start').notNull(),
    micro_usd: bigint('micro_usd', { mode: 'number' }).notNull(),
    created_at: epochMs('created_at').notNull(),
    /** 租期。进程崩溃后没人释放的预占过了这个时间就不再计入月预算。 */
    expires_at: epochMs('expires_at').notNull(),
  },
  (t) => [index('idx_gpt_direct_budget_holds_key').on(t.fingerprint, t.month_start)],
)
