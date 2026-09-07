/**
 * 待推集合与同步检查点：本机改过、还没被服务端收下的东西。持久化在 localStorage 的
 * 用户 scope 下，重启后仍在，所以断网期间的改动不会丢。
 */
import { SYNC_CHECKPOINT_KEY, safeLocalStorage, scopedStorageName } from '../authScope'

export type SyncCollection = 'templates' | 'assets'

export interface SyncCheckpoint {
  /** 客户端持有的服务端版本号。 */
  version: number
  templates: string[]
  assets: string[]
  /** 用户设置最后一次本机改动的时间；null = 没有待推的设置。 */
  settingsUpdatedAt: number | null
  lastSyncedAt: number | null
}

const EMPTY: SyncCheckpoint = {
  version: 0,
  templates: [],
  assets: [],
  settingsUpdatedAt: null,
  lastSyncedAt: null,
}

/** 一次本机改动的标识：记录是 `<集合>:<id>`，用户设置是 `settings`。 */
export type PendingKey = string

let notify: ((key: PendingKey) => void) | null = null

/**
 * 引擎跑起来才开始标脏：能力关闭或匿名的部署里，本机写入一个字节都不该落到同步状态上。
 * 返回停止函数。
 */
export function trackLocalChanges(listener: (key: PendingKey) => void): () => void {
  notify = listener
  return () => {
    if (notify === listener) notify = null
  }
}

export function markRecordDirty(collection: SyncCollection, id: string): void {
  if (!notify) return
  const checkpoint = readPendingChanges()
  if (!checkpoint[collection].includes(id)) {
    writePendingChanges({ ...checkpoint, [collection]: [...checkpoint[collection], id] })
  }
  notify(`${collection}:${id}`)
}

export function markSettingsDirty(updatedAt: number): void {
  if (!notify) return
  writePendingChanges({ ...readPendingChanges(), settingsUpdatedAt: updatedAt })
  notify('settings')
}

export function readPendingChanges(): SyncCheckpoint {
  const raw = safeLocalStorage.getItem(scopedStorageName(SYNC_CHECKPOINT_KEY))
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Partial<SyncCheckpoint>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      templates: stringArray(parsed.templates),
      assets: stringArray(parsed.assets),
      settingsUpdatedAt:
        typeof parsed.settingsUpdatedAt === 'number' ? parsed.settingsUpdatedAt : null,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : null,
    }
  } catch {
    return EMPTY
  }
}

export function writePendingChanges(checkpoint: SyncCheckpoint): void {
  safeLocalStorage.setItem(scopedStorageName(SYNC_CHECKPOINT_KEY), JSON.stringify(checkpoint))
}

export function pendingCount(checkpoint: SyncCheckpoint): number {
  return (
    checkpoint.templates.length +
    checkpoint.assets.length +
    (checkpoint.settingsUpdatedAt === null ? 0 : 1)
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}
