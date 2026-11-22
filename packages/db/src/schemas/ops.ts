import type { ClientErrorKind } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs, operatorOverrideJsonb } from './common'

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
    index('idx_operator_audits_operator_time').on(t.operator_id, t.created_at.desc(), t.id.desc()),
  ],
)

/** One validated operator override per capability/quota key. Unknown keys are tolerated on read. */
export const operator_config_overrides = pgTable(
  'operator_config_overrides',
  {
    key: text('key').primaryKey(),
    value: operatorOverrideJsonb('value').notNull(),
    revision: integer('revision').notNull().default(1),
    baseline_value: operatorOverrideJsonb('baseline_value').notNull(),
    operator_id: text('operator_id').notNull(),
    reason: text('reason').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    check('operator_config_overrides_revision_check', sql`${t.revision} > 0`),
    check('operator_config_overrides_reason_check', sql`char_length(btrim(${t.reason})) > 0`),
  ],
)
export const operator_config_state = pgTable('operator_config_state', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
})

export type OperatorConfigOverride = typeof operator_config_overrides.$inferSelect
export type OperatorAudit = typeof operator_audits.$inferSelect
export type NewOperatorAudit = typeof operator_audits.$inferInsert
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

/**
 * 浏览器上报的错误事件，一次上报一行，只留近 30 天。运营后台按 fingerprint 聚合成问题看；
 * 指纹由后端算，同一处代码换了构建（文件名哈希变了）仍落在同一组。
 */
export const client_errors = pgTable(
  'client_errors',
  {
    id: text('id').primaryKey(),
    received_at: epochMs('received_at').notNull(),
    kind: text('kind').$type<ClientErrorKind>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    name: text('name'),
    message: text('message').notNull(),
    stack: text('stack'),
    url: text('url'),
    release: text('release'),
    device_id: text('device_id'),
    /** 上报时带着有效会话才有；不挂外键，用户删了错误记录照留到过期。 */
    user_id: text('user_id'),
    user_agent: text('user_agent'),
    context: bunJsonb('context').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('idx_client_errors_received').on(t.received_at.desc()),
    index('idx_client_errors_fingerprint').on(t.fingerprint, t.received_at.desc()),
    check('client_errors_kind_check', sql`${t.kind} IN ('boot', 'error', 'rejection', 'react')`),
  ],
)

/** Success evidence is separate from error counts and may arrive before the failure beacon. */
export const client_error_recoveries = pgTable(
  'client_error_recoveries',
  {
    id: text('id').primaryKey(),
    incident_id: text('incident_id').notNull(),
    operation: text('operation').notNull(),
    received_at: epochMs('received_at').notNull(),
    device_id: text('device_id').notNull(),
    user_id: text('user_id'),
  },
  (t) => [
    index('idx_client_error_recoveries_incident').on(t.incident_id, t.device_id),
    index('idx_client_error_recoveries_received').on(t.received_at),
  ],
)

/** Structured operational logs. BFF/worker write; Admin only reads. */
export const server_logs = pgTable(
  'server_logs',
  {
    id: text('id').primaryKey(),
    at: epochMs('at').notNull(),
    service: text('service').$type<import('@image-playground/shared').ServerLogService>().notNull(),
    instance: text('instance').notNull(),
    version: text('version').notNull(),
    level: text('level').$type<import('@image-playground/shared').ServerLogLevel>().notNull(),
    event: text('event'),
    group_key: text('group_key').notNull(),
    message: text('message').notNull(),
    request_id: text('request_id'),
    task_id: text('task_id'),
    fields: bunJsonb('fields').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('idx_server_logs_at').on(t.at.desc(), t.id.desc()),
    index('idx_server_logs_instance_at').on(t.instance, t.at.desc(), t.id.desc()),
    index('idx_server_logs_service_level').on(t.service, t.level, t.at.desc()),
    index('idx_server_logs_request').on(t.request_id, t.at.desc()),
    index('idx_server_logs_task').on(t.task_id, t.at.desc()),
    check(
      'server_logs_service_check',
      sql`${t.service} IN ('bff', 'worker', 'admin', 'router', 'cloudflared', 'host-collector', 'pg-backup', 'migrate', 'web', 'other')`,
    ),
    check(
      'server_logs_level_check',
      sql`${t.level} IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal')`,
    ),
  ],
)
