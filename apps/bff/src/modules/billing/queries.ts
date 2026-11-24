import {
  creditAccounts,
  creditLedger,
  modelPrices,
  referralRelationships,
  subscriptions,
  taskHolds,
} from '@image-playground/db/billing'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lte,
  notExists,
  sql,
} from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import { dayInTimezone, resolveActivityRange } from './calculations'
import { deploymentTimezone } from './config'
import {
  feishuWithoutCreditAccount,
  reconcileAccount,
  scanDueAccounts,
  unmeteredEntitlement,
} from './entitlement'

const ledgerWithTaskSpend = {
  ...getTableColumns(creditLedger),
  task_net_spend: taskHolds.net_spend,
  task_hold_status: taskHolds.status,
  task_settled_at: taskHolds.settled_at,
  task_kind: sql<
    'analysis' | null
  >`CASE WHEN EXISTS (SELECT 1 FROM ${publicSchema.analysis_tasks} WHERE ${publicSchema.analysis_tasks.task_id} = ${creditLedger.task_id}) THEN 'analysis' ELSE NULL END`,
}

export async function getAccountSnapshot(userId: string, now = Date.now()) {
  return db.transaction(async (tx) => {
    const entitlement = await unmeteredEntitlement(tx, userId)
    const denied = !entitlement && (await feishuWithoutCreditAccount(tx, userId))
    const state = entitlement || denied ? null : await reconcileAccount(tx, userId, now)
    const ledger =
      entitlement || denied
        ? []
        : await tx
            .select(ledgerWithTaskSpend)
            .from(creditLedger)
            .leftJoin(taskHolds, eq(creditLedger.task_id, taskHolds.task_id))
            .where(eq(creditLedger.user_id, userId))
            .orderBy(desc(creditLedger.created_at), desc(creditLedger.id))
            .limit(100)
    const availability = await tx.select().from(publicSchema.model_availability)
    const availabilityByModel = new Map(availability.map((row) => [row.model, row.active]))
    const prices = (await tx.select().from(modelPrices))
      .filter((price) => availabilityByModel.get(price.model) !== false)
      .map((price) => ({ ...price, active: true }))
    return {
      account: state?.account ?? null,
      subscription: state?.subscription ?? null,
      ledger,
      model_prices: prices,
      access_state: denied ? ('access_denied' as const) : null,
      unmetered: entitlement,
    }
  })
}

export async function getLedgerPage(userId: string, offset: number, limit: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error('invalid_pagination')
  }
  const rows = await db
    .select(ledgerWithTaskSpend)
    .from(creditLedger)
    .leftJoin(taskHolds, eq(creditLedger.task_id, taskHolds.task_id))
    .where(eq(creditLedger.user_id, userId))
    .orderBy(desc(creditLedger.created_at), desc(creditLedger.id))
    .offset(offset)
    .limit(limit + 1)
  const hasMore = rows.length > limit
  return {
    ledger: rows.slice(0, limit),
    next_offset: hasMore ? offset + limit : null,
  }
}

/** 一个任务的净消耗：预扣减实际退回。每次调用现造一个，同一个 SQL 片段不能在两处 alias。 */
const netSpendPerTask = () => sql<number>`
  coalesce(sum(-${creditLedger.amount}) filter (where ${creditLedger.entry_type} = 'hold'), 0)
  - coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.entry_type} = 'release'), 0)
`

/**
 * 消耗按天聚合：先按任务把退回净掉，再整笔归到 commit 那天——按天净值会让跨日的退回记出负数。
 * 省略 userId 即全站。
 */
export async function getSpendActivity(input: { userId?: string; from?: string; to?: string }) {
  const timezone = deploymentTimezone
  const range = resolveActivityRange({
    from: input.from,
    to: input.to,
    today: dayInTimezone(Date.now(), timezone),
  })
  const netSpend = netSpendPerTask()
  const perTask = db
    .select({
      day: sql<string>`to_char(min(${creditLedger.created_at}) filter (where ${creditLedger.entry_type} = 'commit') at time zone ${timezone}, 'YYYY-MM-DD')`.as(
        'day',
      ),
      spend: netSpend.as('spend'),
    })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.entry_type, ['hold', 'commit', 'release']),
        isNotNull(creditLedger.task_id),
        input.userId ? eq(creditLedger.user_id, input.userId) : undefined,
      ),
    )
    .groupBy(creditLedger.task_id)
    .having(sql`${netSpend} > 0`)
    .as('per_task')

  const days = await db
    .select({ date: perTask.day, count: sql<number>`sum(${perTask.spend})::int` })
    .from(perTask)
    .where(and(gte(perTask.day, range.from), lte(perTask.day, range.to)))
    .groupBy(perTask.day)
    .orderBy(asc(perTask.day))

  return { ...range, timezone, days }
}

export async function getUserSummaries(userIds: string[]) {
  const uniqueIds = [...new Set(userIds)]
  const relationships =
    uniqueIds.length > 0
      ? await db
          .select({
            user_id: referralRelationships.user_id,
            inviter_user_id: referralRelationships.inviter_user_id,
          })
          .from(referralRelationships)
          .where(inArray(referralRelationships.user_id, uniqueIds))
      : []
  const relationshipByUser = new Map(relationships.map((row) => [row.user_id, row]))
  const inviterIds = [...new Set(relationships.map((row) => row.inviter_user_id))]
  const inviters =
    inviterIds.length > 0
      ? await db
          .select({ user_id: publicSchema.users.id, username: publicSchema.users.username })
          .from(publicSchema.users)
          .where(inArray(publicSchema.users.id, inviterIds))
      : []
  const inviterById = new Map(inviters.map((row) => [row.user_id, row]))

  const summaries = await Promise.all(
    uniqueIds.map(async (userId) => {
      const state = await db.transaction(async (tx) => {
        // Enterprise identities intentionally have no credit account. Reuse the
        // same durable-fact checks as the account snapshot so an admin listing
        // cannot create financial state (or fail in ensureAccount).
        const entitlement = await unmeteredEntitlement(tx, userId)
        const noCreditAccount = await feishuWithoutCreditAccount(tx, userId)
        return entitlement || noCreditAccount ? null : reconcileAccount(tx, userId)
      })
      const relationship = relationshipByUser.get(userId)
      const inviter = relationship ? inviterById.get(relationship.inviter_user_id) : undefined
      return {
        user_id: userId,
        subscription_balance: state?.account?.subscription_balance ?? 0,
        recharge_balance: state?.account?.recharge_balance ?? 0,
        subscription_expires_at: state?.account?.subscription_expires_at ?? null,
        subscription: state?.subscription
          ? {
              plan_id: state.subscription.plan.id,
              plan_name: state.subscription.plan.name,
              ends_at: state.subscription.ends_at,
              status: state.subscription.status,
            }
          : null,
        registration_source: relationship ? ('invited' as const) : ('direct_or_unknown' as const),
        inviter:
          relationship && inviter
            ? { user_id: relationship.inviter_user_id, username: inviter.username }
            : null,
      }
    }),
  )
  return { summaries }
}

export async function getBillingOverview() {
  await scanDueAccounts()
  const [[accountTotals], [activeTotals]] = await Promise.all([
    db
      .select({
        accounts: sql<number>`count(*)::int`,
        subscription_credits: sql<number>`coalesce(sum(${creditAccounts.subscription_balance}), 0)::bigint`,
        recharge_credits: sql<number>`coalesce(sum(${creditAccounts.recharge_balance}), 0)::bigint`,
      })
      .from(creditAccounts),
    db
      .select({ active_subscriptions: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.status, 'active')),
  ])
  return {
    accounts: Number(accountTotals?.accounts ?? 0),
    active_subscriptions: Number(activeTotals?.active_subscriptions ?? 0),
    subscription_credits: Number(accountTotals?.subscription_credits ?? 0),
    recharge_credits: Number(accountTotals?.recharge_credits ?? 0),
  }
}

/** 对话消耗汇总：省略 userId 即全站。只出数字，会话标题与消息内容不进后台。 */
export async function getChatUsageSummary(userId?: string) {
  const chatModels = db
    .select({ model: modelPrices.model })
    .from(modelPrices)
    .where(eq(modelPrices.unit, 'kilo_token'))
  // 先按模型收窄再聚合：不筛的话每次汇总都要把整张账本（绝大多数是生图）分组一遍。
  const perTask = db
    .select({ task_id: creditLedger.task_id, spend: netSpendPerTask().as('spend') })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.entry_type, ['hold', 'commit', 'release']),
        isNotNull(creditLedger.task_id),
        inArray(creditLedger.model, chatModels),
        userId ? eq(creditLedger.user_id, userId) : undefined,
      ),
    )
    .groupBy(creditLedger.task_id)
    .as('per_task')

  const [totals] = await db
    .select({
      turns: sql<number>`count(*)::int`,
      input_tokens: sql<number>`coalesce(sum(${taskHolds.input_tokens}), 0)::bigint`,
      output_tokens: sql<number>`coalesce(sum(${taskHolds.output_tokens}), 0)::bigint`,
      credits: sql<number>`coalesce(sum(${perTask.spend}), 0)::bigint`,
    })
    .from(taskHolds)
    .innerJoin(
      modelPrices,
      and(eq(modelPrices.model, taskHolds.model), eq(modelPrices.unit, 'kilo_token')),
    )
    .leftJoin(perTask, eq(perTask.task_id, taskHolds.task_id))
    .where(
      and(
        eq(taskHolds.status, 'committed'),
        userId ? eq(taskHolds.user_id, userId) : undefined,
        // Independent analysis facts remain after transient task cleanup; token pricing alone is not a chat turn.
        notExists(
          db
            .select({ id: publicSchema.analysis_tasks.task_id })
            .from(publicSchema.analysis_tasks)
            .where(eq(publicSchema.analysis_tasks.task_id, taskHolds.task_id)),
        ),
      ),
    )
  return {
    turns: Number(totals?.turns ?? 0),
    input_tokens: Number(totals?.input_tokens ?? 0),
    output_tokens: Number(totals?.output_tokens ?? 0),
    credits: Number(totals?.credits ?? 0),
  }
}
