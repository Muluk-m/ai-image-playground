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
import { assetStore } from '../../features/library/lib/assetStore'
import { templateStore } from '../../features/library/lib/templateStore'
import { useLibraryStore } from '../../features/library/store'
import type { AssetRecord, TemplateRecord, Tombstone } from '../../features/library/types'
import { useStore } from '../../store'
import { isClientCapabilityEnabled } from '../clientCapabilities'
import { forgetUploadedAssetImages, uploadAssetImage } from './assetImages'
import {
  type DirtyRecord,
  dropPendingRecords,
  markSettingsDirty,
  type PendingKey,
  pendingCount,
  publishCheckpoint,
  readPendingChanges,
  type SyncCheckpoint,
  type SyncCollection,
  trackLocalChanges,
  writePendingChanges,
} from './pending'
import { useSyncStatus } from './status'
import { postSync } from './syncClient'
import { applyUserSettingsDocument, readUserSettingsDocument } from './userSettings'

const PUSH_DEBOUNCE_MS = 2000

let pushTimer: ReturnType<typeof setTimeout> | null = null
/** 非 null 表示有请求在飞，集合里是这期间又改了什么——它们不能被这一轮的清账抹掉。 */
let changedInFlight: Set<PendingKey> | null = null
let settingsSnapshot = ''
let applyingRemote = false
/** 上一次看到的、用户设置文档取值的那几片 store 状态。 */
let watched: unknown[] = []

/** 能力关闭时引擎完全不启动：不标脏、不发请求、不写任何存储。 */
export function startSyncEngine(): () => void {
  if (!isClientCapabilityEnabled('accounts:sync')) return () => {}

  settingsSnapshot = JSON.stringify(readUserSettingsDocument())
  forgetUploadedAssetImages()
  publishCheckpoint()
  useSyncStatus.setState({ enabled: true })

  const stopTracking = trackLocalChanges(onLocalChange)
  const unsubscribe = useStore.subscribe(onStoreChange)
  document.addEventListener('visibilitychange', flushOnHide)
  window.addEventListener('online', pushOnReconnect)
  void syncNow()

  return () => {
    stopTracking()
    unsubscribe()
    document.removeEventListener('visibilitychange', flushOnHide)
    window.removeEventListener('online', pushOnReconnect)
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
  let again = false
  try {
    const checkpoint = readPendingChanges()
    const request = await buildRequest(checkpoint)
    const response = await postSync(request, options)
    await applyResponse(response)
    settle(request, response)
    useSyncStatus.setState({ status: 'idle' })
    again = filledOneRequest(request)
  } catch {
    useSyncStatus.setState({ status: 'error' })
    // 失败不自排重试，否则断网时会变成每 2 秒一次的空转；补推交给 `online` 与下一次本机改动。
  } finally {
    changedInFlight = null
    if (again || pushed.size > 0) schedulePush()
  }
}

/** 装满一次请求就说明还有没带走的，紧接着再推一轮。 */
function filledOneRequest(request: SyncRequestBody): boolean {
  return [request.templates, request.assets].some(
    (changes) => (changes?.length ?? 0) >= SYNC_MAX_CHANGES_PER_COLLECTION,
  )
}

function onLocalChange(key: PendingKey, record?: DirtyRecord): void {
  changedInFlight?.add(key)
  // 素材图不等元数据的 debounce：建素材那一刻就开始传，记录才追得上它。
  if (record?.imageId) void uploadAssetImage(record.imageId)
  schedulePush()
}

/** store 的每次写入都会走到这里，先比对象身份，只有可能变过才去序列化文档。 */
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

  const serialized = JSON.stringify(readUserSettingsDocument())
  if (serialized === settingsSnapshot) return
  settingsSnapshot = serialized
  markSettingsDirty(Date.now())
}

function flushOnHide(): void {
  if (document.visibilityState !== 'hidden') return
  if (pendingCount(readPendingChanges()) === 0) return
  void syncNow({ keepalive: true })
}

function pushOnReconnect(): void {
  if (pendingCount(readPendingChanges()) > 0) void syncNow()
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
  const [templates, assets] = await Promise.all([
    templateStore.listChanges(),
    assetStore.listChanges(),
  ])
  return {
    version: checkpoint.version,
    templates: collect(templates, checkpoint.templates).map(toWire),
    assets: await withImagesUploaded(collect(assets, checkpoint.assets)),
    settings:
      checkpoint.settingsUpdatedAt === null
        ? null
        : { updatedAt: checkpoint.settingsUpdatedAt, document: readUserSettingsDocument() },
  }
}

/** 协议侧的 params 是 jsonb，本机侧是具名类型，只有这一个字段需要放宽。 */
function toWire(row: TemplateRecord | Tombstone): SyncTemplateChange {
  return 'deletedAt' in row ? row : { ...row, params: { ...row.params } as Record<string, unknown> }
}

/** 一次请求最多带走这么多，其余留在待推集合里等下一轮。 */
function collect<T extends { id: string }>(
  rows: Array<T | Tombstone>,
  pendingIds: readonly string[],
): Array<T | Tombstone> {
  const wanted = new Set(pendingIds)
  return rows.filter((row) => wanted.has(row.id)).slice(0, SYNC_MAX_CHANGES_PER_COLLECTION)
}

/**
 * 先图后记录：服务端只收图片本体已经在它那边的素材记录。图还没传上去的这一轮不推，
 * 留在待推集合里等下一轮；服务端明确不收的（配额、类型）摘出待推集合，改标「未同步」。
 */
async function withImagesUploaded(
  changes: Array<AssetRecord | Tombstone>,
): Promise<Array<AssetRecord | Tombstone>> {
  const outcomes = await Promise.all(
    changes.map((change) =>
      'imageId' in change ? uploadAssetImage(change.imageId) : Promise.resolve('uploaded' as const),
    ),
  )
  const refused = changes.filter((_, index) => outcomes[index] === 'refused').map((row) => row.id)
  if (refused.length > 0) dropPendingRecords('assets', refused)
  return changes.filter((_, index) => outcomes[index] === 'uploaded')
}

async function applyResponse(response: SyncResponseBody): Promise<void> {
  await Promise.all([
    templateStore.applyRemote(response.templates as Array<TemplateRecord | Tombstone>),
    assetStore.applyRemote(response.assets as Array<AssetRecord | Tombstone>),
  ])

  applyingRemote = true
  try {
    if (response.settings) applyUserSettingsDocument(response.settings.document)
  } finally {
    applyingRemote = false
    settingsSnapshot = JSON.stringify(readUserSettingsDocument())
  }

  const library = useLibraryStore.getState()
  await Promise.all([
    response.templates.length > 0 ? library.loadTemplates() : null,
    response.assets.length > 0 ? library.loadAssets() : null,
  ])
}

/** 清账：推上去的从待推集合里划掉，被拒的和飞行期间又改过的留下。 */
function settle(request: SyncRequestBody, response: SyncResponseBody): void {
  const rejected = new Set(response.rejected.map((rejection) => rejection.id))
  const keep = (collection: SyncCollection) => {
    const sent = new Set(request[collection]?.map((change) => change.id))
    return (id: string) =>
      !sent.has(id) || rejected.has(id) || (changedInFlight?.has(`${collection}:${id}`) ?? false)
  }

  const current = readPendingChanges()
  const next: SyncCheckpoint = {
    version: response.version,
    templates: current.templates.filter(keep('templates')),
    assets: current.assets.filter(keep('assets')),
    settingsUpdatedAt:
      request.settings && !changedInFlight?.has('settings') ? null : current.settingsUpdatedAt,
    lastSyncedAt: Date.now(),
    unsyncedImages: current.unsyncedImages,
  }
  writePendingChanges(next)
}
