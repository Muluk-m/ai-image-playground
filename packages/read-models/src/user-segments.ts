import { type SQL, sql } from 'drizzle-orm'
import type { ReadModelsDb } from './sql-helpers'
import type { UserSegment } from './types'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface UserSegmentFilterOptions {
  billingCreditsEnabled?: boolean
  now?: number
}

export interface UserSegmentCountPlan {
  readonly keys: readonly UserSegment[]
  readonly ctes: SQL
  readonly joins: SQL
  readonly columns: SQL
}

async function hasBillingSegmentTables(db: ReadModelsDb): Promise<boolean> {
  // Billing relations are optional on self-hosted installations. Read-models only reads the
  // persisted facts here so counting an entire segment cannot reconcile or create accounts.
  const [availability] = await db.execute(sql`
    SELECT to_regclass('billing_subscriptions') IS NOT NULL
       AND to_regclass('billing_credit_accounts') IS NOT NULL
       AND to_regclass('billing_unmetered_entitlements') IS NOT NULL AS billing
  `)
  return availability?.billing === true
}

export async function userSegmentFilters(
  db: ReadModelsDb,
  options: UserSegmentFilterOptions = {},
): Promise<Map<UserSegment, SQL>> {
  const now = options.now ?? Date.now()
  const weekAgo = new Date(now - WEEK_MS)
  const filters = new Map<UserSegment, SQL>([
    [
      'active-7d',
      sql`(u.last_login_at >= ${weekAgo} OR EXISTS (
        SELECT 1 FROM queue_tasks t WHERE t.user_id = u.id AND t.submitted_at >= ${weekAgo}
      ))`,
    ],
    ['disabled', sql`u.status = 'disabled'`],
  ])

  if (!options.billingCreditsEnabled) return filters
  if (!(await hasBillingSegmentTables(db))) return filters

  const at = new Date(now)
  const activeSubscription = sql`
    s.user_id = u.id AND s.status = 'active' AND s.starts_at <= ${at} AND s.ends_at > ${at}
  `
  filters.set(
    'members',
    sql`EXISTS (SELECT 1 FROM billing_subscriptions s WHERE ${activeSubscription})`,
  )
  filters.set(
    'expiring',
    sql`EXISTS (
    SELECT 1 FROM billing_subscriptions s
    WHERE ${activeSubscription} AND s.ends_at <= ${new Date(now + WEEK_MS)}
  )`,
  )
  filters.set(
    'out-of-credits',
    sql`EXISTS (
    SELECT 1 FROM billing_credit_accounts a
    WHERE a.user_id = u.id
      AND a.recharge_balance = 0
      AND (a.subscription_balance = 0 OR a.subscription_expires_at <= ${at})
      AND NOT EXISTS (
        SELECT 1 FROM billing_unmetered_entitlements e WHERE e.user_id = u.id AND e.enabled
      )
  )`,
  )
  return filters
}

/**
 * 与 `userSegmentFilters` 同源的分群计数计划：用预聚合 CTE + Hash Left Join 替代
 * `COUNT(*) FILTER (WHERE EXISTS (...))`，避免 PostgreSQL 对每个用户行重复跑关联 SubPlan。
 */
export function buildUserSegmentCountPlan(
  segments: ReadonlyMap<UserSegment, SQL>,
  now: number,
): UserSegmentCountPlan {
  const at = new Date(now)
  const weekAgo = new Date(now - WEEK_MS)
  const weekAhead = new Date(now + WEEK_MS)
  const hasBilling = segments.has('members')
  const keys: UserSegment[] = hasBilling
    ? ['active-7d', 'disabled', 'members', 'expiring', 'out-of-credits']
    : ['active-7d', 'disabled']
  return {
    keys,
    ctes: sql`
      WITH recent_task_users AS (
        SELECT DISTINCT t.user_id
        FROM queue_tasks t
        WHERE t.user_id IS NOT NULL AND t.submitted_at >= ${weekAgo}
      )
      ${
        hasBilling
          ? sql`,
      active_sub_users AS (
        SELECT
          s.user_id,
          BOOL_OR(s.ends_at <= ${weekAhead}) AS expiring
        FROM billing_subscriptions s
        WHERE s.status = 'active' AND s.starts_at <= ${at} AND s.ends_at > ${at}
        GROUP BY s.user_id
      ),
      out_of_credit_users AS (
        SELECT DISTINCT a.user_id
        FROM billing_credit_accounts a
        WHERE a.recharge_balance = 0
          AND (a.subscription_balance = 0 OR a.subscription_expires_at <= ${at})
          AND NOT EXISTS (
            SELECT 1 FROM billing_unmetered_entitlements e
            WHERE e.user_id = a.user_id AND e.enabled
          )
      )`
          : sql``
      }
    `,
    joins: sql`
      LEFT JOIN recent_task_users rtu ON rtu.user_id = u.id
      ${
        hasBilling
          ? sql`
      LEFT JOIN active_sub_users asu ON asu.user_id = u.id
      LEFT JOIN out_of_credit_users ooc ON ooc.user_id = u.id`
          : sql``
      }
    `,
    columns: sql`
      COUNT(*) FILTER (WHERE u.last_login_at >= ${weekAgo} OR rtu.user_id IS NOT NULL)::int AS "active-7d",
      COUNT(*) FILTER (WHERE u.status = 'disabled')::int AS "disabled"
      ${
        hasBilling
          ? sql`,
      COUNT(*) FILTER (WHERE asu.user_id IS NOT NULL)::int AS "members",
      COUNT(*) FILTER (WHERE asu.expiring IS TRUE)::int AS "expiring",
      COUNT(*) FILTER (WHERE ooc.user_id IS NOT NULL)::int AS "out-of-credits"`
          : sql``
      }
    `,
  }
}
