import type { OpsBackupObject, OpsBackups } from '@image-playground/shared'
import { Elysia } from 'elysia'
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

/** 运维看板要的、只有后端够得着的现状。只读，内部令牌保护，经后台代理给运营者。 */
export const internalOpsRoutes = new Elysia({ prefix: '/internal/admin/ops' })
  .use(requireInternalService)
  .get('/backups', () => readBackups())
