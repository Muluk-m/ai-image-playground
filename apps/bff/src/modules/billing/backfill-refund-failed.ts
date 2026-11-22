import { createDb, tasks } from '@image-playground/db'
import { creditAccounts, creditLedger, taskHolds } from '@image-playground/db/billing'
import { and, eq, sql } from 'drizzle-orm'
import { ledgerRow, refundableSubscriptionAmount } from './settlement'

type BillingDb = ReturnType<typeof createDb>['db']

const NOTE = 'backfill: failed task refund'

export interface BackfillRow {
  taskId: string
  userId: string
  model: string
  subscriptionRefund: number
  rechargeRefund: number
  expiredSubscription: number
  upstreamInvocationCount: number
  errorType: string | null
  upstreamStatus: number | null
}

export interface BackfillReport {
  dryRun: boolean
  refundedTasks: number
  /** hold 还在 committed，但积分账户已经不存在（销号）。跳过并如实报数，不要当成退成功。 */
  skippedTasks: number
  refundedSubscription: number
  refundedRecharge: number
  expiredSubscription: number
  rows: BackfillRow[]
}

/**
 * 退回历史上「失败却被扣钱」的任务积分。旧结算规则只看上游是否被调用过，所以调用了上游
 * 又失败的任务留下了 committed 的 hold；本命令把它们改判为 release。
 *
 * 幂等靠 hold.status='committed' 这个前置条件：退过一次就不再是 committed。
 */
export async function backfillRefundFailedTasks(input: {
  db: BillingDb
  now?: number
  dryRun?: boolean
}): Promise<BackfillReport> {
  const now = input.now ?? Date.now()
  const dryRun = input.dryRun ?? false
  const candidates = await input.db
    .select({
      taskId: taskHolds.task_id,
      upstreamInvocationCount: tasks.upstream_invocation_count,
      errorType: tasks.error_type,
      upstreamStatus: tasks.upstream_status,
    })
    .from(taskHolds)
    .innerJoin(tasks, eq(tasks.id, taskHolds.task_id))
    .where(and(eq(taskHolds.status, 'committed'), eq(tasks.status, 'failed')))
    .orderBy(taskHolds.created_at)

  const rows: BackfillRow[] = []
  let skippedTasks = 0
  for (const candidate of candidates) {
    const refund = await input.db.transaction(async (tx) => {
      const [hold] = await tx
        .select()
        .from(taskHolds)
        .where(and(eq(taskHolds.task_id, candidate.taskId), eq(taskHolds.status, 'committed')))
        .for('update')
        .limit(1)
      if (!hold) return null

      const [account] = await tx
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.user_id, hold.user_id))
        .for('update')
        .limit(1)
      if (!account) return 'skipped' as const

      const subscriptionRefund = refundableSubscriptionAmount({
        subscriptionAmount: hold.subscription_amount,
        holdExpiresAt: hold.subscription_expires_at,
        accountExpiresAt: account.subscription_expires_at,
        now,
      })
      const rechargeRefund = hold.recharge_amount
      const expiredSubscription = hold.subscription_amount - subscriptionRefund

      const row: BackfillRow = {
        taskId: hold.task_id,
        userId: hold.user_id,
        model: hold.model,
        subscriptionRefund,
        rechargeRefund,
        expiredSubscription,
        upstreamInvocationCount: candidate.upstreamInvocationCount,
        errorType: candidate.errorType,
        upstreamStatus: candidate.upstreamStatus,
      }
      if (dryRun) return row

      if (subscriptionRefund > 0 || rechargeRefund > 0) {
        await tx
          .update(creditAccounts)
          .set({
            subscription_balance: sql`${creditAccounts.subscription_balance} + ${subscriptionRefund}`,
            recharge_balance: sql`${creditAccounts.recharge_balance} + ${rechargeRefund}`,
            updated_at: now,
          })
          .where(eq(creditAccounts.user_id, hold.user_id))
      }
      await tx
        .update(taskHolds)
        .set({
          status: 'released',
          settled_at: now,
          net_spend: hold.total_amount - subscriptionRefund - rechargeRefund,
        })
        .where(eq(taskHolds.task_id, hold.task_id))

      const entries = (
        [
          ['subscription', hold.subscription_amount, subscriptionRefund],
          ['recharge', hold.recharge_amount, rechargeRefund],
        ] as const
      )
        .filter(([, heldAmount]) => heldAmount > 0)
        .map(([bucket, heldAmount, refundedAmount]) => {
          const expiredAmount = heldAmount - refundedAmount
          return ledgerRow({
            userId: hold.user_id,
            bucket,
            type: 'release',
            amount: refundedAmount,
            now,
            taskId: hold.task_id,
            model: hold.model,
            quantity: hold.quantity,
            note: expiredAmount > 0 ? `${NOTE}（${expiredAmount} 套餐积分已过期，未退回）` : NOTE,
            metadata: {
              backfill: true,
              upstream_invocation_count: candidate.upstreamInvocationCount,
              ...(candidate.errorType ? { error_type: candidate.errorType } : {}),
              ...(candidate.upstreamStatus === null
                ? {}
                : { upstream_status: candidate.upstreamStatus }),
              ...(expiredAmount > 0 ? { expired_amount: expiredAmount } : {}),
            },
          })
        })
      if (entries.length) await tx.insert(creditLedger).values(entries)
      return row
    })
    if (refund === 'skipped') skippedTasks += 1
    else if (refund) rows.push(refund)
  }

  return {
    dryRun,
    refundedTasks: rows.length,
    skippedTasks,
    refundedSubscription: rows.reduce((sum, row) => sum + row.subscriptionRefund, 0),
    refundedRecharge: rows.reduce((sum, row) => sum + row.rechargeRefund, 0),
    expiredSubscription: rows.reduce((sum, row) => sum + row.expiredSubscription, 0),
    rows,
  }
}

function formatReport(report: BackfillReport): string {
  const lines = report.rows.map((row) => {
    const expired = row.expiredSubscription > 0 ? ` expired=${row.expiredSubscription}` : ''
    const reason = [row.errorType, row.upstreamStatus].filter(Boolean).join(' ')
    return `${row.taskId}  user=${row.userId}  ${row.model}  subscription=${row.subscriptionRefund}  recharge=${row.rechargeRefund}${expired}  invocations=${row.upstreamInvocationCount}  ${reason}`
  })
  const skipped = report.skippedTasks > 0 ? `, skipped ${report.skippedTasks} (no account)` : ''
  lines.push(
    `${report.dryRun ? 'DRY RUN — nothing written' : 'applied'}: ${report.refundedTasks} tasks, subscription ${report.refundedSubscription}, recharge ${report.refundedRecharge}, expired subscription ${report.expiredSubscription}${skipped}`,
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const databaseUrl = process.env.APP_DATABASE_URL
  if (!databaseUrl) throw new Error('APP_DATABASE_URL is required')
  const dryRun = process.argv.includes('--dry-run')
  const handle = createDb(databaseUrl)
  try {
    console.log(formatReport(await backfillRefundFailedTasks({ db: handle.db, dryRun })))
  } finally {
    await handle.close()
  }
}
