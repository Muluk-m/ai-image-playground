/**
 * 待推集合与同步检查点：本机改过、还没被服务端收下的东西。持久化在 localStorage 的
 * 用户 scope 下，重启后仍在，所以断网期间的改动不会丢。
 */
import { SYNC_CHECKPOINT_KEY, safeLocalStorage, scopedStorageName } from '../authScope'
import { isClientCapabilityEnabled } from '../clientCapabilities'
import { useSyncStatus } from './status'

export type SyncCollection = 'templates' | 'assets'

/** 标脏时随通知带上的记录；`imageId` 只有素材有，引擎靠它决定先传哪张图。 */
export interface DirtyRecord {
  readonly id: string
  readonly imageId?: string
}

export interface SyncCheckpoint {
  /** 客户端持有的服务端版本号。 */
  version: number
  templates: string[]
  assets: string[]
  /** 用户设置最后一次本机改动的时间；null = 没有待推的设置。 */
  settingsUpdatedAt: number | null
  lastSyncedAt: number | null
  /** 服务端不会再收的素材图；引用它们的素材在本机照常可用，只标「未同步」。 */
  unsyncedImages: string[]
}

const EMPTY: SyncCheckpoint = {
  version: 0,
  templates: [],
  assets: [],
  settingsUpdatedAt: null,
  lastSyncedAt: null,
  unsyncedImages: [],
}

/** 一次本机改动的标识：记录是 `<集合>:<id>`，用户设置是 `settings`。 */
export type PendingKey = string

type ChangeListener = (key: PendingKey, record?: DirtyRecord) => void

let notify: ChangeListener | null = null

/**
 * 引擎跑起来才开始标脏：能力关闭或匿名的部署里，本机写入一个字节都不该落到同步状态上。
 * 返回停止函数。
 */
export function trackLocalChanges(listener: ChangeListener): () => void {
  notify = listener
  return () => {
    if (notify === listener) notify = null
  }
}

export function markRecordDirty(collection: SyncCollection, record: DirtyRecord): void {
  if (!notify) return
  const checkpoint = readPendingChanges()
  if (!checkpoint[collection].includes(record.id)) {
    writePendingChanges({ ...checkpoint, [collection]: [...checkpoint[collection], record.id] })
  }
  notify(`${collection}:${record.id}`, record)
}

/**
 * 匿名库领养来的模板、素材与用户设置一次性标脏。领养跑在引擎启动之前，没有监听者可通知，
 * 所以直接落检查点；能力关闭时一个字节都不写。
 */
export function markAdoptedDirty(adopted: {
  templates: readonly string[]
  assets: readonly string[]
  settings: boolean
}): void {
  if (!isClientCapabilityEnabled('accounts:sync')) return
  if (adopted.templates.length === 0 && adopted.assets.length === 0 && !adopted.settings) return
  const checkpoint = readPendingChanges()
  writePendingChanges({
    ...checkpoint,
    templates: union(checkpoint.templates, adopted.templates),
    assets: union(checkpoint.assets, adopted.assets),
    settingsUpdatedAt: adopted.settings ? Date.now() : checkpoint.settingsUpdatedAt,
  })
}

function union(current: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...current, ...added])]
}

/** 推不上去也不再重试的记录（图片本体被服务端拒了）从待推集合里摘掉。 */
export function dropPendingRecords(collection: SyncCollection, ids: readonly string[]): void {
  const checkpoint = readPendingChanges()
  const kept = checkpoint[collection].filter((id) => !ids.includes(id))
  if (kept.length === checkpoint[collection].length) return
  writePendingChanges({ ...checkpoint, [collection]: kept })
}

export function markImageUnsynced(imageId: string): void {
  const checkpoint = readPendingChanges()
  if (checkpoint.unsyncedImages.includes(imageId)) return
  writePendingChanges({
    ...checkpoint,
    unsyncedImages: [...checkpoint.unsyncedImages, imageId],
  })
}

export function clearImageUnsynced(imageId: string): void {
  const checkpoint = readPendingChanges()
  if (!checkpoint.unsyncedImages.includes(imageId)) return
  writePendingChanges({
    ...checkpoint,
    unsyncedImages: checkpoint.unsyncedImages.filter((id) => id !== imageId),
  })
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
      unsyncedImages: stringArray(parsed.unsyncedImages),
    }
  } catch {
    return EMPTY
  }
}

export function writePendingChanges(checkpoint: SyncCheckpoint): void {
  safeLocalStorage.setItem(scopedStorageName(SYNC_CHECKPOINT_KEY), JSON.stringify(checkpoint))
  publish(checkpoint)
}

/** 引擎启动时把已在本机的检查点推给 UI。 */
export function publishCheckpoint(): void {
  publish(readPendingChanges())
}

function publish(checkpoint: SyncCheckpoint): void {
  useSyncStatus.setState({
    pending: pendingCount(checkpoint),
    lastSyncedAt: checkpoint.lastSyncedAt,
    unsyncedImages: checkpoint.unsyncedImages,
  })
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
