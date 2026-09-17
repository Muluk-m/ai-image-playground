import type { HostSample, OpsBackupObject, OpsBackups } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { type ObjectEntry, objectStore } from '../lib/objectStore'
import { requireInternalService } from '../lib/user-auth'

/** pg-backup 容器把每天的 dump 传到这个前缀下，key 形如 `pg/2026-09-17.dump`。 */
const BACKUP_PREFIX = 'pg/'

function toBackup(entry: ObjectEntry | undefined): OpsBackupObject | null {
  if (!entry) return null
  return { key: entry.key, size_bytes: entry.size, modified_at: entry.lastModified }
}

/**
 * 看的是真正落在桶里的文件，不是备份脚本自称的成功：脚本的成功痕迹是容器里一个文件的 mtime，
 * 容器一启动就会被刷成健康。带上前一份是为了让调用方看出「今天这份突然小了一个量级」。
 */
export async function readBackups(): Promise<OpsBackups> {
  const dumps = (await objectStore().listEntries(BACKUP_PREFIX))
    .filter((entry) => entry.key.endsWith('.dump'))
    .sort((a, b) => b.lastModified - a.lastModified || b.key.localeCompare(a.key))
  return { latest: toBackup(dumps[0]), previous: toBackup(dumps[1]) }
}

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
