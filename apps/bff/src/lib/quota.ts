import { type QuotaConsumeResult, tryConsumeQuotaSync } from '@image-playground/db'

export {
  currentQuotaDate,
  nextResetISO,
  type QuotaConsumeResult,
  tryConsumeQuotaSync,
} from '@image-playground/db'

type QuotaDatabase = Pick<
  import('@image-playground/db').ImagePlaygroundDatabase,
  'insert' | 'select'
>

export async function tryConsumeQuota(
  device_id: string,
  n: number,
  dbInstance?: QuotaDatabase,
): Promise<QuotaConsumeResult> {
  const database = dbInstance ?? (await import('../db/client')).db
  return tryConsumeQuotaSync(device_id, n, database)
}
