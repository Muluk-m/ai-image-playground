import type { HostSample } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { readBackups } from '../lib/ops-backups'
import { requireInternalService } from '../lib/user-auth'

/** 采集方的时钟允许的超前量；再往后的读数只可能是坏数据。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000

/** 形状由 schema 管，这里管的是数值说不说得通：负数、零容量、可用量大过总量、来自未来。 */
function isPlausibleHostSample(sample: HostSample): boolean {
  const counts = [
    sample.disk_total_bytes,
    sample.disk_available_bytes,
    sample.mem_total_bytes,
    sample.mem_available_bytes,
  ]
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return false
  if (sample.disk_total_bytes === 0 || sample.mem_total_bytes === 0) return false
  if (sample.disk_available_bytes > sample.disk_total_bytes) return false
  if (sample.mem_available_bytes > sample.mem_total_bytes) return false
  return Number.isSafeInteger(sample.sampled_at) && sample.sampled_at <= Date.now() + CLOCK_SKEW_MS
}

/** 运维看板要的、只有后端够得着的现状。读的部分经后台代理给运营者，写的部分只收采集容器的读数；都由内部令牌保护。 */
export const internalOpsRoutes = new Elysia({ prefix: '/internal/admin/ops' })
  .use(requireInternalService)
  .get('/backups', () => readBackups())
  .post(
    '/host-samples',
    async ({ body, status }) => {
      if (!isPlausibleHostSample(body)) return status(400, { error: 'invalid_host_sample' })
      // 采集方重试时会带着同一个 sampled_at 再来一次；那是同一次读数，不是新的一行。
      await db.insert(schema.host_samples).values(body).onConflictDoNothing()
      return status(204)
    },
    {
      body: t.Object({
        sampled_at: t.Number(),
        disk_total_bytes: t.Number(),
        disk_available_bytes: t.Number(),
        mem_total_bytes: t.Number(),
        mem_available_bytes: t.Number(),
      }),
    },
  )
