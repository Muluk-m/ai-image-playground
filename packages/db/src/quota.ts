import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { ImagePlaygroundDatabase } from './client'
import { daily_quota } from './schema'

export interface QuotaConsumeResult {
  ok: boolean
  count: number
  reset_at: string
}

export function currentQuotaDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextResetISO(): string {
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

type QuotaDatabase = Pick<ImagePlaygroundDatabase, 'insert' | 'select'>

export function tryConsumeQuotaSync(
  device_id: string,
  n: number,
  db: QuotaDatabase,
): QuotaConsumeResult {
  const date = currentQuotaDate()
  const rows = db
    .insert(daily_quota)
    .values({ device_id, date, count: n })
    .onConflictDoUpdate({
      target: [daily_quota.device_id, daily_quota.date],
      set: { count: sql`${daily_quota.count} + ${n}` },
      setWhere: sql`${daily_quota.count} + ${n} <= ${DAILY_QUOTA_LIMIT}`,
    })
    .returning({ count: daily_quota.count })
    .all()

  if (rows.length === 0) {
    const [existing] = db
      .select({ count: daily_quota.count })
      .from(daily_quota)
      .where(and(eq(daily_quota.device_id, device_id), eq(daily_quota.date, date)))
      .limit(1)
      .all()
    return {
      ok: false,
      count: existing?.count ?? DAILY_QUOTA_LIMIT,
      reset_at: nextResetISO(),
    }
  }

  return { ok: true, count: rows[0]!.count, reset_at: nextResetISO() }
}
