import { type SQL, sql } from 'drizzle-orm'
import type { ReadModelsDb } from './sql-helpers'
import type { UserSegment } from './types'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface UserSegmentFilterOptions {
  billingCreditsEnabled?: boolean
  now?: number
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

  // Billing relations are optional on self-hosted installations. Read-models only reads the
  // persisted facts here so counting an entire segment cannot reconcile or create accounts.
  const [availability] = await db.execute(sql`
    SELECT to_regclass('billing_subscriptions') IS NOT NULL
       AND to_regclass('billing_credit_accounts') IS NOT NULL
       AND to_regclass('billing_unmetered_entitlements') IS NOT NULL AS billing
  `)
  if (availability?.billing !== true) return filters

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
