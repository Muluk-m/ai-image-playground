import type {
  AgentBatchPriceSnapshot,
  AgentTurnUsage,
  AgentVisualEvidence,
  AnalysisCoverage,
  AnalysisFinding,
  AnalysisInputSnapshot,
  GenerationParameters,
  GenerationSource,
  GenerationSummary,
  ImageTierSnapshot,
  PersistedSubmitRequest,
  QueueProvider,
  TaskErrorType,
  TaskKind,
  TaskStatus,
} from '@image-playground/shared'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  pgView,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs } from './common'
import { cli_connections, users } from './identity'
import { media_objects } from './media'

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<QueueProvider>().notNull(),
    model: text('model').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    reconciliation_required: boolean('reconciliation_required').notNull().default(false),
    request_payload: bunJsonb('request_payload').$type<PersistedSubmitRequest>().notNull(),
    /** Submission-time billing mode and pricing inputs; terminal paths reuse this immutable snapshot. */
    metering: bunJsonb('metering').$type<{
      mode: 'credits' | 'none'
      model: string
      quantity: number
      unitMultiplier: number
      pricing?: AgentBatchPriceSnapshot
      /** 提交时定下的档位决定；2026-11 之前的任务行没有。 */
      tier?: ImageTierSnapshot
    } | null>(),
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
    /** GPT Image 这一单最后走的通道；会员高档参数落到 sub2api 时结算按基础档。 */
    gpt_route: text('gpt_route').$type<'direct' | 'sub2api'>(),
    /** 最后实际发出直连请求的 key 指纹；只存可展示的 HMAC 指纹，不存密钥。 */
    gpt_key_fingerprint: text('gpt_key_fingerprint'),
    /** 提交请求的 W3C traceparent；worker 执行时用 span link 接回提交链路（ADR 0033）。 */
    traceparent: text('traceparent'),
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
    /**
     * 进入结果确认的时刻。30 分钟告警和卡片上的「确认中」用它。
     * 下次核对的时刻仍写在 next_retry_at，两者不能混用，否则退避会把告警时钟拨回去。
     */
    reconcile_started_at: epochMs('reconcile_started_at'),
    /** 结果确认超过 30 分钟的告警已经发出的时刻。重启和多 worker 都靠它去重。 */
    reconcile_alerted_at: epochMs('reconcile_alerted_at'),
    device_id: text('device_id').generatedAlwaysAs(sql`request_payload ->> 'device_id'`),
    /** 智能体工具提交的任务带上会话与轮；用户自己提交的任务两列都是 null。 */
    agent_conversation_id: text('agent_conversation_id'),
    agent_turn_id: text('agent_turn_id'),
    kind: text('kind').$type<TaskKind>().notNull().default('queue'),
  },
  (t) => [
    check(
      'tasks_reconciling_check',
      sql`${t.status} <> 'reconciling' OR ${t.reconciliation_required}`,
    ),
    check('tasks_kind_check', sql`${t.kind} IN ('queue', 'chat', 'analysis')`),
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
    index('idx_tasks_agent_submitted')
      .on(t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.agent_conversation_id} IS NOT NULL`),
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
    // 后台任务列表在 31 天窗口里按模型、供应商、状态、错误类型筛选。前缀是等值列，时间在后面。
    index('idx_tasks_model_submitted')
      .on(t.model, t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.kind} = 'queue'`),
    index('idx_tasks_provider_submitted')
      .on(t.provider, t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.kind} = 'queue'`),
    index('idx_tasks_status_submitted')
      .on(t.status, t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.kind} = 'queue'`),
    index('idx_tasks_error_submitted')
      .on(t.error_type, t.submitted_at.desc(), t.id.desc())
      .where(sql`${t.kind} = 'queue' AND ${t.error_type} IS NOT NULL`),
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
// operational view. GPT route attribution is intentionally visible to the operator console.
const {
  reconciliation_required: _reconciliationRequired,
  archive_payload: _archivePayload,
  archive_retry_started_at: _archiveRetryStartedAt,
  execution_token: _executionToken,
  lease_expires_at: _leaseExpiresAt,
  reconcile_started_at: _reconcileStartedAt,
  reconcile_alerted_at: _reconcileAlertedAt,
  metering: _metering,
  gpt_route: gptRouteColumn,
  gpt_key_fingerprint: gptKeyFingerprintColumn,
  traceparent: _traceparent,
  ...queueTaskColumns
} = getTableColumns(tasks)
export const queue_tasks = pgView('queue_tasks').as((qb) =>
  qb
    .select({
      ...queueTaskColumns,
      gpt_route: gptRouteColumn,
      gpt_key_fingerprint: gptKeyFingerprintColumn,
    })
    .from(tasks)
    .where(eq(tasks.kind, 'queue')),
)

export const task_dispatches = pgTable(
  'task_dispatches',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    execution_token: text('execution_token').notNull(),
    intended_at: epochMs('intended_at').notNull(),
    dispatched_at: epochMs('dispatched_at'),
    upstream_request_id: text('upstream_request_id'),
    upstream_task_id: text('upstream_task_id'),
  },
  (t) => [index('idx_task_dispatches_task').on(t.task_id, t.intended_at)],
)

/** Queue tasks submitted through the CLI API, for source attribution and reliability metrics. */
export const cli_jobs = pgTable(
  'cli_jobs',
  {
    task_id: text('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id').references(() => cli_connections.id, {
      onDelete: 'set null',
    }),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [index('idx_cli_jobs_user_created').on(t.user_id, t.created_at)],
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
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
    // 对话项目没有画布封面时按会话找最近一次生成（`apps/bff/src/lib/projects.ts`）。
    index('idx_generation_records_conversation')
      .on(t.user_id, sql`(${t.source} ->> 'conversationId')`, t.created_at.desc())
      .where(sql`${t.deleted_at} IS NULL`),
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
  (t) => [
    primaryKey({ columns: [t.user_id, t.command_id] }),
    // 连点防重：同账号、同请求内容、最近几秒。
    index('idx_generation_commands_recent').on(t.user_id, t.request_hash, t.submitted_at),
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
    /** 单张产出软删（「我的作品」只删一张）。作品列表与详情按它过滤；原件不动。 */
    deleted_at: epochMs('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.generation_id, t.role, t.position] }),
    check('generation_images_role_check', sql`${t.role} IN ('input', 'mask', 'output')`),
  ],
)

export const analysis_tasks = pgTable(
  'analysis_tasks',
  {
    task_id: text('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    device_id: text('device_id').notNull(),
    batch_id: text('batch_id').notNull(),
    plan_version: integer('plan_version').notNull(),
    item_key: text('item_key').notNull(),
    attempt: integer('attempt').notNull(),
    origin_conversation_id: text('origin_conversation_id'),
    origin_turn_id: text('origin_turn_id').notNull(),
    model: text('model').notNull(),
    input_snapshot: bunJsonb('input_snapshot').$type<AnalysisInputSnapshot>().notNull(),
    price_snapshot: bunJsonb('price_snapshot').$type<AgentBatchPriceSnapshot>().notNull(),
    reserved_credits: integer('reserved_credits').notNull(),
    actual_credits: integer('actual_credits'),
    status: text('status').$type<TaskStatus>().notNull(),
    findings: bunJsonb('findings').$type<AnalysisFinding[]>(),
    coverage: bunJsonb('coverage').$type<AnalysisCoverage>(),
    evidence: bunJsonb('evidence').$type<readonly AgentVisualEvidence[]>(),
    error_code: text('error_code'),
    created_at: epochMs('created_at').notNull(),
    completed_at: epochMs('completed_at'),
  },
  (t) => [
    uniqueIndex('idx_analysis_tasks_item_attempt').on(t.batch_id, t.item_key, t.attempt),
    index('idx_analysis_tasks_owner_created').on(t.user_id, t.created_at.desc(), t.task_id),
    check('analysis_tasks_attempt_check', sql`${t.attempt} > 0`),
    check('analysis_tasks_reserved_check', sql`${t.reserved_credits} >= 0`),
    check(
      'analysis_tasks_status_check',
      sql`${t.status} IN ('queued', 'in_progress', 'reconciling', 'completed', 'failed', 'cancelled')`,
    ),
  ],
)

export const analysis_model_calls = pgTable(
  'analysis_model_calls',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id')
      .notNull()
      .references(() => analysis_tasks.task_id),
    execution_token: text('execution_token'),
    model: text('model').notNull(),
    status: text('status')
      .$type<'prepared' | 'dispatched' | 'completed' | 'failed' | 'cancelled' | 'unknown'>()
      .notNull(),
    http_dispatch_count: integer('http_dispatch_count').notNull().default(0),
    request_bytes: bigint('request_bytes', { mode: 'number' }),
    upstream_request_id: text('upstream_request_id'),
    local_rejection: text('local_rejection'),
    usage: bunJsonb('usage').$type<AgentTurnUsage>(),
    response_content: text('response_content'),
    started_at: epochMs('started_at').notNull(),
    dispatched_at: epochMs('dispatched_at'),
    finished_at: epochMs('finished_at'),
  },
  (t) => [
    uniqueIndex('idx_analysis_model_calls_task').on(t.task_id),
    check('analysis_model_calls_dispatch_check', sql`${t.http_dispatch_count} IN (0, 1)`),
    check(
      'analysis_model_calls_status_check',
      sql`${t.status} IN ('prepared', 'dispatched', 'completed', 'failed', 'cancelled', 'unknown')`,
    ),
  ],
)
