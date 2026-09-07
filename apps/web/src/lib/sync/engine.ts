/**
 * 同步引擎：本机改动向上推、服务端回传向下盖。合并规则只在服务端存在一份，
 * 这里对回传的记录一律无条件覆盖，不做任何本地裁决。
 */
import type {
  SyncRequestBody,
  SyncResponseBody,
  SyncTemplateChange,
} from '@image-playground/shared'
import { SYNC_MAX_CHANGES_PER_COLLECTION } from '@image-playground/shared'
import { create } from 'zustand'
import { assetStore } from '../../features/library/lib/assetStore'
import { templateStore } from '../../features/library/lib/templateStore'
import { useLibraryStore } from '../../features/library/store'
import type { AssetRecord, TemplateRecord, Tombstone } from '../../features/library/types'
import { useStore } from '../../store'
import { isClientCapabilityEnabled } from '../clientCapabilities'
import {
  markSettingsDirty,
  type PendingKey,
  pendingCount,
  readPendingChanges,
  type SyncCheckpoint,
  trackLocalChanges,
  writePendingChanges,
} from './pending'
import { postSync } from './syncClient'
import { applyUserSettingsDocument, readUserSettingsDocument } from './userSettings'

const PUSH_DEBOUNCE_MS = 2000

export type SyncStatus = 'idle' | 'syncing' | 'error'

interface SyncStatusState {
  enabled: boolean
  status: SyncStatus
  pending: number
  lastSyncedAt: number | null
}

export const useSyncStatus = create<SyncStatusState>(() => ({
  enabled: false,
  status: 'idle',
  pending: 0,
  lastSyncedAt: null,
}))

let pushTimer: ReturnType<typeof setTimeout> | null = null
/** 非 null 表示有请求在飞，集合里是这期间又改了什么——它们不能被这一轮的清账抹掉。 */
let changedInFlight: Set<PendingKey> | null = null
let settingsSnapshot = ''
let applyingRemote = false

/** 能力关闭时引擎完全不启动：不标脏、不发请求、不写任何存储。 */
export function startSyncEngine(): () => void {
  if (!isClientCapabilityEnabled('accounts:sync')) return () => {}

  settingsSnapshot = serialize(readUserSettingsDocument())
  publish(readPendingChanges())
  useSyncStatus.setState({ enabled: true })

  const stopTracking = trackLocalChanges(onLocalChange)
  const unsubscribe = useStore.subscribe(onStoreChange)
  document.addEventListener('visibilitychange', flushOnHide)
  void syncNow()

  return () => {
    stopTracking()
    unsubscribe()
    document.removeEventListener('visibilitychange', flushOnHide)
    clearTimer()
    useSyncStatus.setState({ enabled: false, status: 'idle' })
  }
}

/** 「立即重试」与页面隐藏时的冲刷都走这里。 */
export async function syncNow(options: { keepalive?: boolean } = {}): Promise<void> {
  if (changedInFlight) return
  clearTimer()
  changedInFlight = new Set()
  useSyncStatus.setState({ status: 'syncing' })

  const pushed = changedInFlight
  try {
    const checkpoint = readPendingChanges()
    const request = await buildRequest(checkpoint)
    const response = await postSync(request, options)
    await applyResponse(response)
    settle(request, response)
    useSyncStatus.setState({ status: 'idle' })
  } catch {
    useSyncStatus.setState({ status: 'error' })
  } finally {
    changedInFlight = null
    if (pushed.size > 0) schedulePush()
  }
}

function onLocalChange(key: PendingKey): void {
  changedInFlight?.add(key)
  publish(readPendingChanges())
  schedulePush()
}

/** store 的每次写入都会走到这里，先比对象身份，只有可能变过才去序列化文档。 */
let watched: unknown[] = []
function onStoreChange(): void {
  const state = useStore.getState()
  const next = [
    state.settings,
    state.params,
    state.appMode,
    state.pinnedInspirationIds,
    state.inspirationCoachDismissed,
    state.libraryCoachDismissed,
    state.libraryPanelOpened,
    state.assetHintShown,
  ]
  const changed = next.some((slice, index) => slice !== watched[index])
  watched = next
  if (!changed || applyingRemote) return

  const serialized = serialize(readUserSettingsDocument())
  if (serialized === settingsSnapshot) return
  settingsSnapshot = serialized
  markSettingsDirty(Date.now())
}

function flushOnHide(): void {
  if (document.visibilityState !== 'hidden') return
  if (pendingCount(readPendingChanges()) === 0) return
  void syncNow({ keepalive: true })
}

function schedulePush(): void {
  clearTimer()
  pushTimer = setTimeout(() => {
    pushTimer = null
    void syncNow()
  }, PUSH_DEBOUNCE_MS)
}

function clearTimer(): void {
  if (pushTimer !== null) clearTimeout(pushTimer)
  pushTimer = null
}

async function buildRequest(checkpoint: SyncCheckpoint): Promise<SyncRequestBody> {
  return {
    version: checkpoint.version,
    templates: (
      await collect<TemplateRecord>(templateStore.listChanges(), checkpoint.templates)
    ).map(toWire),
    assets: await collect<AssetRecord>(assetStore.listChanges(), checkpoint.assets),
    settings:
      checkpoint.settingsUpdatedAt === null
        ? null
        : {
            updatedAt: checkpoint.settingsUpdatedAt,
            document: readUserSettingsDocument() as unknown as Record<string, unknown>,
          },
  }
}

/** 协议侧的 params 是 jsonb，本机侧是具名类型，只有这一个字段需要放宽。 */
function toWire(row: TemplateRecord | Tombstone): SyncTemplateChange {
  return 'deletedAt' in row ? row : { ...row, params: { ...row.params } as Record<string, unknown> }
}

/** 一次请求推不完的留在待推集合里，成功后紧接着再推一轮。 */
async function collect<T extends { id: string }>(
  rows: Promise<Array<T | Tombstone>>,
  pendingIds: readonly string[],
): Promise<Array<T | Tombstone>> {
  const wanted = new Set(pendingIds)
  return (await rows).filter((row) => wanted.has(row.id)).slice(0, SYNC_MAX_CHANGES_PER_COLLECTION)
}

async function applyResponse(response: SyncResponseBody): Promise<void> {
  await templateStore.applyRemote(response.templates as Array<TemplateRecord | Tombstone>)
  await assetStore.applyRemote(response.assets as Array<AssetRecord | Tombstone>)

  applyingRemote = true
  try {
    if (response.settings) applyUserSettingsDocument(response.settings.document)
  } finally {
    applyingRemote = false
    settingsSnapshot = serialize(readUserSettingsDocument())
  }

  const library = useLibraryStore.getState()
  if (response.templates.length > 0) await library.loadTemplates()
  if (response.assets.length > 0) await library.loadAssets()
}

/** 清账：推上去的从待推集合里划掉，被拒的和飞行期间又改过的留下。 */
function settle(request: SyncRequestBody, response: SyncResponseBody): void {
  const rejected = new Set(response.rejected.map((rejection) => rejection.id))
  const keep = (collection: 'templates' | 'assets') => (id: string) =>
    !request[collection]?.some((change) => change.id === id) ||
    rejected.has(id) ||
    (changedInFlight?.has(`${collection}:${id}`) ?? false)

  const current = readPendingChanges()
  const next: SyncCheckpoint = {
    version: response.version,
    templates: current.templates.filter(keep('templates')),
    assets: current.assets.filter(keep('assets')),
    settingsUpdatedAt:
      request.settings && !changedInFlight?.has('settings') ? null : current.settingsUpdatedAt,
    lastSyncedAt: Date.now(),
  }
  writePendingChanges(next)
  publish(next)
}

function publish(checkpoint: SyncCheckpoint): void {
  useSyncStatus.setState({
    pending: pendingCount(checkpoint),
    lastSyncedAt: checkpoint.lastSyncedAt,
  })
}

/** 字段顺序稳定的序列化，用来判断文档有没有真的变过。 */
function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
