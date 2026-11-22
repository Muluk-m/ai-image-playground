import { createDb, tasks } from '@image-playground/db'
import { taskHolds } from '@image-playground/db/billing'
import { and, eq, isNull, sql } from 'drizzle-orm'

type BillingDb = ReturnType<typeof createDb>['db']

/**
 * 任务与预扣的一致性检查，只读。
 *
 * 任务（`tasks.status`）和预扣（`billing_task_holds.status`）是两台必须一起走的状态机：
 * 任务写终态与 `finalizeTask` 结算在同一个事务里，所以任何时刻一次快照里都只应看到下面这几种组合：
 *
 *   queued / in_progress / reconciling  ->  held
 *   completed                           ->  committed
 *   failed / cancelled                  ->  released
 *
 * 其它组合都是对不上的账。预扣的 `task_id` 有指向 `tasks(id)` 的外键（级联删除），
 * 数据库保证「有预扣就有任务」，但管不了两边的状态是否配套，只能靠这里查。
 * 历史上出现过一次（旧规则下失败任务被扣钱，见 backfill-refund-failed.ts），当时靠人手工发现。
 *
 * 只做 SELECT，且整个检查放在一个 REPEATABLE READ 的只读事务里，几条查询看到的是同一份快照。
 *
 * 运行：HOLD_CHECK_DATABASE_URL（缺省依次用 ADMIN_DATABASE_URL、APP_DATABASE_URL）
 *   bun run apps/bff/src/modules/billing/hold-consistency.ts [--json] [--limit=N] [--stale-hours=N]
 * 退出码：0 对得上，1 有违规，2 参数错误，3 检查本身失败（连不上库、没有权限等）。
 * 对生产库执行属于「跑脚本」，按 docs/agents/prod-readonly.md 须 Nain 批准。
 */

/** 违规：账确实对不上。 */
export const VIOLATION_KINDS = [
  /** 任务已经结束，预扣还占着：用户的积分一直被锁。 */
  'stuck_hold',
  /** 任务完成了，预扣却是已退回：交付了结果没收钱。 */
  'delivered_not_charged',
  /** 任务失败或被取消，预扣却是已扣款：用户什么也没拿到却被扣钱。 */
  'charged_without_result',
  /** 任务还在排队或执行，预扣已经结算。 */
  'early_settlement',
  /** 任务不计费（metering.mode = none，如免单账号）却有预扣：免单用户被扣了钱。 */
  'hold_on_unmetered_task',
  /** 预扣记录自相矛盾：held 却有结算时间，或已结算却没有结算时间。 */
  'hold_state_incoherent',
  /** 需要计费的任务没有预扣记录，`finalizeTask` 会静默跳过它。 */
  'missing_hold',
  /** 任务状态取值不在已知集合里（`tasks.status` 没有数据库约束）。 */
  'unknown_task_status',
] as const
export type ViolationKind = (typeof VIOLATION_KINDS)[number]

/** 提示：不一定有问题，供人判断。不计入失败。 */
export const INFO_KINDS = [
  /** 排队或执行中的任务带着预扣超过阈值：任务可能卡住了，积分一直被锁。 */
  'stale_active_hold',
] as const
export type InfoKind = (typeof INFO_KINDS)[number]

export type MismatchKind = ViolationKind | InfoKind

export interface Mismatch {
  kind: MismatchKind
  taskId: string
  userId: string | null
  model: string
  taskKind: string | null
  taskStatus: string | null
  holdStatus: string | null
  /** 预扣总额；没有预扣记录时为 null。 */
  amount: number | null
  /** 这条不一致大约从什么时候开始：已结束任务用完成时间，否则用预扣创建或任务提交时间。 */
  since: number | null
}

export interface KindCount {
  tasks: number
  credits: number
}

export interface ConsistencyReport {
  checkedAt: number
  /** 没有任何违规（提示类不算）。 */
  ok: boolean
  counts: Record<MismatchKind, KindCount>
  /** 每类按最早的先列，每类最多 `sampleLimit` 条。 */
  samples: Mismatch[]
}

const FINISHED = ['completed', 'failed', 'cancelled'] as const
const ACTIVE = ['queued', 'in_progress', 'reconciling'] as const
const TASK_STATUSES = [...ACTIVE, ...FINISHED]

/** 常量取值列表，只接受本文件里的字面量，不拼接任何外部输入。 */
const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

const DAY_MS = 86_400_000
const DEFAULT_STALE_AFTER_MS = DAY_MS

/**
 * 预扣与任务都存在时的分类；组合正常时为 NULL。顺序即优先级。
 * `staleBefore` 是毫秒时间戳，以整数字面量写进 SQL（不用参数：SELECT 与 GROUP BY 里的参数占位符
 * 不同，数据库会认为不是同一个表达式）。
 */
function joinedKind(staleBefore: number) {
  const before = sql.raw(`to_timestamp(${Math.trunc(staleBefore)} / 1000.0)`)
  return sql<MismatchKind | null>`CASE
  WHEN ${tasks.status} NOT IN (${list(TASK_STATUSES)}) THEN 'unknown_task_status'
  WHEN ${tasks.status} IN (${list(FINISHED)}) AND ${taskHolds.status} = 'held' THEN 'stuck_hold'
  WHEN ${tasks.status} = 'completed' AND ${taskHolds.status} = 'released' THEN 'delivered_not_charged'
  WHEN ${tasks.status} IN ('failed', 'cancelled') AND ${taskHolds.status} = 'committed' THEN 'charged_without_result'
  WHEN ${tasks.status} IN (${list(ACTIVE)}) AND ${taskHolds.status} IN ('committed', 'released') THEN 'early_settlement'
  WHEN ${tasks.metering}->>'mode' = 'none' THEN 'hold_on_unmetered_task'
  WHEN (${taskHolds.status} = 'held') <> (${taskHolds.settled_at} IS NULL) THEN 'hold_state_incoherent'
  WHEN ${tasks.status} IN ('queued', 'in_progress') AND ${taskHolds.status} = 'held' AND ${tasks.submitted_at} < ${before} THEN 'stale_active_hold'
END`
}

/** 联表查询能分出来的类别（missing_hold 是任务没有预扣，要单独查）。 */
const JOINED_KINDS: readonly MismatchKind[] = [
  ...VIOLATION_KINDS.filter((kind) => kind !== 'missing_hold'),
  ...INFO_KINDS,
]

function emptyCounts(): Record<MismatchKind, KindCount> {
  const counts = {} as Record<MismatchKind, KindCount>
  for (const kind of [...VIOLATION_KINDS, ...INFO_KINDS]) counts[kind] = { tasks: 0, credits: 0 }
  return counts
}

/** 只读检查。`sampleLimit` 是每一类最多列出的条数，计数不受它限制。 */
export async function checkHoldConsistency(input: {
  db: BillingDb
  now?: number
  sampleLimit?: number
  /** 排队或执行中的任务带预扣超过多久算「可能卡住」，默认 24 小时。 */
  staleAfterMs?: number
}): Promise<ConsistencyReport> {
  const checkedAt = input.now ?? Date.now()
  const sampleLimit = input.sampleLimit ?? 20
  const kindOf = joinedKind(checkedAt - (input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS))
  return input.db.transaction(
    async (tx) => {
      const counts = emptyCounts()
      const samples: Mismatch[] = []

      // 1. 预扣与任务都在，但组合不对。
      const grouped = await tx
        .select({
          kind: kindOf,
          tasks: sql<number>`count(*)::int`,
          credits: sql<number>`coalesce(sum(${taskHolds.total_amount}), 0)::int`,
        })
        .from(taskHolds)
        .innerJoin(tasks, eq(tasks.id, taskHolds.task_id))
        .where(sql`${kindOf} IS NOT NULL`)
        .groupBy(kindOf)
      for (const row of grouped) {
        if (row.kind) counts[row.kind] = { tasks: row.tasks, credits: row.credits }
      }
      for (const kind of JOINED_KINDS) {
        if (counts[kind].tasks === 0) continue
        const rows = await tx
          .select({
            taskId: taskHolds.task_id,
            userId: taskHolds.user_id,
            model: taskHolds.model,
            taskKind: tasks.kind,
            taskStatus: tasks.status,
            holdStatus: taskHolds.status,
            amount: taskHolds.total_amount,
            since:
              sql<number>`(extract(epoch FROM coalesce(${tasks.completed_at}, ${taskHolds.created_at})) * 1000)::bigint`.mapWith(
                Number,
              ),
          })
          .from(taskHolds)
          .innerJoin(tasks, eq(tasks.id, taskHolds.task_id))
          .where(sql`${kindOf} = ${kind}`)
          .orderBy(taskHolds.created_at)
          .limit(sampleLimit)
        samples.push(...rows.map((row) => ({ kind, ...row })))
      }

      // 2. 需要计费的任务没有预扣记录。metering 为空的是开计费之前的任务，不算。
      // 分析任务在 billing:chat-free 下 metering.mode 仍写 credits，但按设计不预扣，
      // 它的 metering.pricing.exemption 记着豁免类型，这里只查 exemption 为 none（或没记）的。
      const missing = sql`${tasks.metering}->>'mode' = 'credits' AND coalesce(${tasks.metering}->'pricing'->>'exemption', 'none') = 'none'`
      const [missingCount] = await tx
        .select({ tasks: sql<number>`count(*)::int` })
        .from(tasks)
        .leftJoin(taskHolds, eq(taskHolds.task_id, tasks.id))
        .where(and(isNull(taskHolds.task_id), missing))
      counts.missing_hold = { tasks: missingCount?.tasks ?? 0, credits: 0 }
      if (counts.missing_hold.tasks > 0) {
        const rows = await tx
          .select({
            taskId: tasks.id,
            userId: tasks.user_id,
            model: tasks.model,
            taskKind: tasks.kind,
            taskStatus: tasks.status,
            since: tasks.submitted_at,
          })
          .from(tasks)
          .leftJoin(taskHolds, eq(taskHolds.task_id, tasks.id))
          .where(and(isNull(taskHolds.task_id), missing))
          .orderBy(tasks.submitted_at)
          .limit(sampleLimit)
        samples.push(
          ...rows.map((row) => ({
            kind: 'missing_hold' as const,
            holdStatus: null,
            amount: null,
            ...row,
          })),
        )
      }

      return {
        checkedAt,
        ok: VIOLATION_KINDS.every((kind) => counts[kind].tasks === 0),
        counts,
        samples,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

function formatSince(since: number | null, now: number): string {
  if (since === null) return 'since ?'
  const days = (now - since) / DAY_MS
  return `${new Date(since).toISOString()} (${days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)}d`} ago)`
}

export function formatConsistencyReport(report: ConsistencyReport): string {
  const lines: string[] = []
  for (const kind of [...VIOLATION_KINDS, ...INFO_KINDS]) {
    const count = report.counts[kind]
    if (count.tasks === 0) continue
    lines.push(
      `${INFO_KINDS.includes(kind as InfoKind) ? 'INFO ' : 'FAIL '}${kind}: ${count.tasks} tasks, ${count.credits} credits`,
    )
    for (const sample of report.samples.filter((one) => one.kind === kind)) {
      lines.push(
        `  ${sample.taskId}  user=${sample.userId ?? '-'}  ${sample.model}  task=${sample.taskStatus ?? '-'}(${sample.taskKind ?? '-'})  hold=${sample.holdStatus ?? '-'}  amount=${sample.amount ?? '-'}  ${formatSince(sample.since, report.checkedAt)}`,
      )
    }
    if (count.tasks > report.samples.filter((one) => one.kind === kind).length) {
      lines.push(
        `  … ${count.tasks - report.samples.filter((one) => one.kind === kind).length} more, oldest first`,
      )
    }
  }
  lines.push(report.ok ? 'OK: no task/hold mismatches' : 'FAILED: task/hold mismatches found')
  return lines.join('\n')
}

function numberArg(name: string, minimum: number): number | undefined | 'invalid' {
  const arg = process.argv.find((one) => one.startsWith(`--${name}=`))
  if (!arg) return undefined
  const value = Number(arg.slice(name.length + 3))
  return Number.isFinite(value) && value >= minimum ? value : 'invalid'
}

if (import.meta.main) {
  const sampleLimit = numberArg('limit', 0)
  const staleHours = numberArg('stale-hours', 0)
  if (sampleLimit === 'invalid' || staleHours === 'invalid') {
    console.error('--limit and --stale-hours must be non-negative numbers')
    process.exit(2)
  }
  const source = ['HOLD_CHECK_DATABASE_URL', 'ADMIN_DATABASE_URL', 'APP_DATABASE_URL'].find(
    (name) => process.env[name],
  )
  if (!source) {
    console.error('set HOLD_CHECK_DATABASE_URL, ADMIN_DATABASE_URL or APP_DATABASE_URL')
    process.exit(2)
  }
  console.error(`checking with ${source} (read-only transaction)`)
  try {
    const handle = createDb(process.env[source] as string)
    try {
      const report = await checkHoldConsistency({
        db: handle.db,
        sampleLimit: sampleLimit === undefined ? undefined : Math.trunc(sampleLimit),
        staleAfterMs: staleHours === undefined ? undefined : staleHours * 3_600_000,
      })
      console.log(
        process.argv.includes('--json')
          ? JSON.stringify(report, null, 2)
          : formatConsistencyReport(report),
      )
      // 0 = 对得上，1 = 有违规；可以直接挂在定时任务上。
      process.exitCode = report.ok ? 0 : 1
    } finally {
      await handle.close()
    }
  } catch (error) {
    // 检查没做成（连不上库、没有权限……）不能和「账对不上」共用退出码 1。
    console.error(
      `hold consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 3
  }
}
