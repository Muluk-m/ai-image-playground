import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'

export interface QuotaConsumeResult {
  ok: boolean
  /** 成功时是更新后的值；失败时是消费前的累计值。 */
  count: number
  /** 下次配额重置时间（UTC 第二天 00:00:00 ISO 字符串）。 */
  reset_at: string
}

/** 可注入的 db 形状：db/client 的全局 drizzle 单例与 transaction 回调的 tx 句柄都满足。 */
type QuotaDatabase = Pick<
  import('@image-playground/db').ImagePlaygroundDatabase,
  'insert' | 'select'
>

export function currentQuotaDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextResetISO(): string {
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

/**
 * 单条原子 UPSERT：INSERT 命中或 ON CONFLICT UPDATE 命中 setWhere 都返回新 count；
 * 仅在 UPDATE 分支因 setWhere 不满足而不命中时返 0 行 → ok=false。
 *
 * 不变量：setWhere 仅作用于 UPDATE 分支。首次 INSERT 不查 limit，依赖 submit
 * 路由的 n ∈ [1, 16] 保证首次插入必不超额（n ≤ DAILY_QUOTA_LIMIT）。
 *
 * `db` 由调用方给定：submit 路由传 BEGIN IMMEDIATE 事务的 tx，让扣配额与建任务
 * 同属一个事务；不持有事务的调用方走下面的 tryConsumeQuota 包装。
 */
export function tryConsumeQuotaSync(
  device_id: string,
  n: number,
  db: QuotaDatabase,
): QuotaConsumeResult {
  const date = currentQuotaDate()
  const rows = db
    .insert(schema.daily_quota)
    .values({ device_id, date, count: n })
    .onConflictDoUpdate({
      target: [schema.daily_quota.device_id, schema.daily_quota.date],
      set: { count: sql`${schema.daily_quota.count} + ${n}` },
      setWhere: sql`${schema.daily_quota.count} + ${n} <= ${DAILY_QUOTA_LIMIT}`,
    })
    .returning({ count: schema.daily_quota.count })
    .all()

  if (rows.length === 0) {
    const [existing] = db
      .select({ count: schema.daily_quota.count })
      .from(schema.daily_quota)
      .where(and(eq(schema.daily_quota.device_id, device_id), eq(schema.daily_quota.date, date)))
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

/**
 * 异步包装：给不持有 SQLite 事务的调用方用，默认懒求值取 db/client 的全局 drizzle
 * 单例。测试可注入一个绑定独立 sqlite 文件的 drizzle 实例，绕开 routes.test.ts 顶层
 * unlink 导致的 SQLITE_IOERR_VNODE 跨文件冲突。
 */
export async function tryConsumeQuota(
  device_id: string,
  n: number,
  dbInstance?: QuotaDatabase,
): Promise<QuotaConsumeResult> {
  const database = dbInstance ?? (await import('../db/client')).db
  return tryConsumeQuotaSync(device_id, n, database)
}
