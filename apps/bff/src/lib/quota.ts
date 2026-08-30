import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { db as globalDb } from '../db/client'
import * as schema from '../db/schema'

export interface QuotaConsumeResult {
  ok: boolean
  /** 成功时是更新后的值；失败时是消费前的累计值。 */
  count: number
  quota: number
  /** 下次配额重置时间（UTC 第二天 00:00:00 ISO 字符串）。 */
  reset_at: string
}

/** Drizzle client and transaction types used by the atomic submit path. */
type QuotaDb = typeof globalDb
type QuotaTransaction = Parameters<Parameters<QuotaDb['transaction']>[0]>[0]
type QuotaExecutor = QuotaDb | QuotaTransaction
export function currentQuotaDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextResetISO(): string {
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

/**
 * Single atomic UPSERT. The configured quota is part of the statement so
 * concurrent submissions cannot exceed it.
 *
 * The optional database and quota parameters support isolated tests without
 * initializing the process-global pool.
 */
export async function tryConsumeQuota(
  device_id: string,
  n: number,
  dbInstance?: QuotaDb,
  dailyImageQuota = DAILY_QUOTA_LIMIT,
): Promise<QuotaConsumeResult> {
  // Keep the default import lazy so tests with an injected database never initialize global storage.
  const db = dbInstance ?? (await import('../db/client')).db
  return consumeQuota(db, device_id, n, dailyImageQuota)
}

/** Variant used by the submit transaction so task insertion and quota consumption stay atomic. */
export async function tryConsumeQuotaInTransaction(
  db: QuotaTransaction,
  device_id: string,
  n: number,
  dailyImageQuota: number,
): Promise<QuotaConsumeResult> {
  return consumeQuota(db, device_id, n, dailyImageQuota)
}

async function consumeQuota(
  db: QuotaExecutor,
  device_id: string,
  n: number,
  dailyImageQuota: number,
): Promise<QuotaConsumeResult> {
  if (!Number.isSafeInteger(dailyImageQuota) || dailyImageQuota < 0)
    throw new RangeError('daily image quota must be non-negative')
  const date = currentQuotaDate()
  if (n <= dailyImageQuota) {
    const rows = await db
      .insert(schema.daily_quota)
      .values({ device_id, date, count: n })
      .onConflictDoUpdate({
        target: [schema.daily_quota.device_id, schema.daily_quota.date],
        set: { count: sql`${schema.daily_quota.count} + ${n}` },
        setWhere: sql`${schema.daily_quota.count} + ${n} <= ${dailyImageQuota}`,
      })
      .returning({ count: schema.daily_quota.count })

    if (rows.length > 0) {
      return { ok: true, count: rows[0]!.count, quota: dailyImageQuota, reset_at: nextResetISO() }
    }
  }

  const [existing] = await db
    .select({ count: schema.daily_quota.count })
    .from(schema.daily_quota)
    .where(and(eq(schema.daily_quota.device_id, device_id), eq(schema.daily_quota.date, date)))
    .limit(1)
  return {
    ok: false,
    count: existing?.count ?? 0,
    quota: dailyImageQuota,
    reset_at: nextResetISO(),
  }
}
