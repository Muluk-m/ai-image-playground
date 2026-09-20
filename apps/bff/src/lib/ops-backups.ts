import type { OpsBackupObject, OpsBackups, OpsRestoreDrill } from '@image-playground/shared'
import { type ObjectEntry, objectStore } from './objectStore'

/** Hourly immutable dumps and their completion checksums; legacy daily dumps remain readable. */
const BACKUP_PREFIX = 'pg/'
/** 同一个容器每周把最新一份 dump 恢复一遍，结果覆盖写在这里。 */
const DRILL_KEY = `${BACKUP_PREFIX}drill/latest.json`

function toBackup(entry: ObjectEntry | undefined): OpsBackupObject | null {
  if (!entry) return null
  return { key: entry.key, size_bytes: entry.size, modified_at: entry.lastModified }
}

/**
 * Use actual R2 objects. New snapshots count only after their completion checksum was uploaded.
 * Retain the preceding snapshot so operators can spot an unexpected size drop.
 */
export async function readBackups(): Promise<OpsBackups> {
  const entries = await objectStore().listEntries(BACKUP_PREFIX)
  const completed = new Set(
    entries
      .filter((entry) => entry.key.endsWith('.dump.sha256'))
      .map((entry) => entry.key.slice(0, -7)),
  )
  const dumps = entries
    // 没有修改时间的对象排不了先后，也算不出距今多久；当它不存在，好过报一份「56 年前」的备份。
    .filter((entry) => entry.key.endsWith('.dump') && entry.lastModified > 0)
    .filter((entry) => /^pg\/\d{4}-\d{2}-\d{2}\.dump$/.test(entry.key) || completed.has(entry.key))
    .sort((a, b) => b.lastModified - a.lastModified || b.key.localeCompare(a.key))
  return { latest: toBackup(dumps[0]), previous: toBackup(dumps[1]) }
}

function parseDrill(bytes: Uint8Array): OpsRestoreDrill | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof raw !== 'object' || raw === null) return null
    const { ok, finished_at, error } = raw as Record<string, unknown>
    const finishedAt = typeof finished_at === 'string' ? Date.parse(finished_at) : Number.NaN
    if (typeof ok !== 'boolean' || Number.isNaN(finishedAt)) return null
    return { ok, finished_at: finishedAt, error: typeof error === 'string' && error ? error : null }
  } catch {
    return null
  }
}

/**
 * 最近一次备份恢复演练的结果，还没演练过就是 null。文件在却读不懂，按演练失败算：
 * 写结果的是演练脚本自己，读不懂说明它半路出了岔子，不能当成通过。
 */
export async function readRestoreDrill(): Promise<OpsRestoreDrill | null> {
  const store = objectStore()
  const entry = (await store.listEntries(DRILL_KEY)).find(
    (candidate) => candidate.key === DRILL_KEY,
  )
  if (!entry) return null
  return (
    parseDrill(await store.read(DRILL_KEY)) ?? {
      ok: false,
      finished_at: entry.lastModified,
      error: '演练结果文件无法解析',
    }
  )
}
