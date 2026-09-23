/**
 * 同步引擎：本机改动向上推、服务端回传向下盖。合并规则只在服务端存在一份，
 * 这里对回传的记录一律无条件覆盖，不做任何本地裁决。
 */
import type {
  SyncAssetChange,
  SyncAssetRecord,
  SyncRequestBody,
  SyncResponseBody,
  SyncTemplateChange,
} from '@image-playground/shared'
import { isSyncTombstone, SYNC_MAX_CHANGES_PER_COLLECTION } from '@image-playground/shared'
import { assetStore } from '../../features/library/lib/assetStore'
import { lookImageIds, lookStore } from '../../features/library/lib/lookStore'
import { templateStore } from '../../features/library/lib/templateStore'
import { useLibraryStore } from '../../features/library/store'
import {
  type AssetRecord,
  type AssetView,
  assetCoverImageId,
  type LookRecord,
  type TemplateRecord,
  type Tombstone,
} from '../../features/library/types'
import { useStore } from '../../store'
import { isClientCapabilityEnabled } from '../clientCapabilities'
import {
  type AssetImageUpload,
  forgetUploadedAssetImages,
  isAssetImageOnServer,
  noteAssetImageOnServer,
  uploadAssetImage,
} from './assetImages'
import {
  type DirtyRecord,
  dropPendingRecords,
  markBulkDirty,
  markSettingsDirty,
  type PendingKey,
  pendingCount,
  publishCheckpoint,
  readPendingChanges,
  type SyncCheckpoint,
  type SyncCollection,
  trackLocalChanges,
  withholdImagelessRecords,
  writePendingChanges,
} from './pending'
import { reportAssetUploads, type SyncFailure, useSyncStatus } from './status'
import { postSync, SyncRequestError } from './syncClient'
import { applyUserSettingsDocument, readUserSettingsDocument } from './userSettings'

const PUSH_DEBOUNCE_MS = 2000
/** 从没有过时间戳的那份用户设置带的时间戳：推得上去，但输给服务端已有的任何一份。 */
const UNTIMESTAMPED_SETTINGS = 1

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
    const request = await buildRequest(options.keepalive ?? false)
    const response = await postSync(request, options)
    await applyResponse(response)
    settle(request, response)
    useSyncStatus.setState({ status: 'idle', failure: null })
    again = filledOneRequest(request)
  } catch (error) {
    // 分三类：会话过期要重新登录；没到达服务端是链路问题；带状态码的是服务端拒了这份内容。
    const status = error instanceof SyncRequestError ? error.status : 0
    const failure: SyncFailure =
      status === 401 || status === 403 ? 'unauthorized' : status === 0 ? 'network' : 'rejected'
    useSyncStatus.setState({ status: 'error', failure })
    // 失败不自排重试，否则断网时会变成每 2 秒一次的空转；补推交给 `online` 与下一次本机改动。
  } finally {
    changedInFlight = null
    reportAssetUploads(0, 0)
    if (again || pushed.size > 0) schedulePush()
  }
}

/** 装满一次请求就说明还有没带走的，紧接着再推一轮。 */
function filledOneRequest(request: SyncRequestBody): boolean {
  return [request.templates, request.assets, request.looks].some(
    (changes) => (changes?.length ?? 0) >= SYNC_MAX_CHANGES_PER_COLLECTION,
  )
}

function onLocalChange(key: PendingKey, record?: DirtyRecord): void {
  changedInFlight?.add(key)
  // 素材图不等元数据的 debounce：建记录那一刻就开始传，记录才追得上它。
  for (const imageId of record?.imageIds ?? []) void uploadAssetImage(imageId)
  schedulePush()
}

/** store 的每次写入都会走到这里，先比对象身份，只有可能变过才去序列化文档。 */
function onStoreChange(): void {
  const state = useStore.getState()
  const next = [
    state.settings,
    state.params,
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

async function buildRequest(hiding: boolean): Promise<SyncRequestBody> {
  const [templates, assets, looks] = await Promise.all([
    templateStore.listChanges(),
    assetStore.listChanges(),
    lookStore.listChanges(),
  ])
  const checkpoint = seedFirstSync(readPendingChanges(), templates, assets, looks)
  const pendingAssets = collect(assets, checkpoint.assets)
  const pendingLooks = collect(looks, checkpoint.looks)
  // 两个集合共用一条进度：用户看见的是「这一轮还有几张图要传」，不分它们属于谁。
  const progress = plannedUploads(hiding, [
    ...liveRecords(pendingAssets).flatMap(assetImageIds),
    ...liveRecords(pendingLooks).flatMap(lookImageIds),
  ])
  return {
    version: checkpoint.version,
    templates: collect(templates, checkpoint.templates).map(toWireTemplate),
    assets: (
      await withImagesUploaded('assets', pendingAssets, assetImageIds, hiding, progress)
    ).map(toWireAsset),
    looks: await withImagesUploaded('looks', pendingLooks, lookImageIds, hiding, progress),
    settings:
      checkpoint.settingsUpdatedAt === null
        ? null
        : { updatedAt: checkpoint.settingsUpdatedAt, document: readUserSettingsDocument() },
  }
}

/**
 * 这个 scope 从没同步完一轮：本机已有的记录与用户设置全部标脏，跟着这一轮一起上去。
 * 判据用 `lastSyncedAt` 而不是版本号——服务端给新用户的版本号也是 0。
 */
function seedFirstSync(
  checkpoint: SyncCheckpoint,
  templates: Array<TemplateRecord | Tombstone>,
  assets: Array<AssetRecord | Tombstone>,
  looks: Array<LookRecord | Tombstone>,
): SyncCheckpoint {
  if (checkpoint.lastSyncedAt !== null) return checkpoint
  markBulkDirty({
    // 墓碑不推：这个 scope 还没同步过，它删掉的记录服务端本来就没有。
    templates: liveIds(templates),
    assets: liveIds(assets),
    looks: liveIds(looks),
    settingsUpdatedAt: UNTIMESTAMPED_SETTINGS,
  })
  return readPendingChanges()
}

function liveRecords<T extends { id: string }>(rows: Array<T | Tombstone>): T[] {
  return rows.filter((row): row is T => !isSyncTombstone(row))
}

function liveIds(rows: Array<{ id: string } | Tombstone>): string[] {
  return rows.filter((row) => !isSyncTombstone(row)).map((row) => row.id)
}

function assetImageIds(asset: AssetRecord): string[] {
  return asset.views.map((view) => view.imageId)
}

/** 协议侧的 params 是 jsonb，本机侧是具名类型，只有这一个字段需要放宽。 */
function toWireTemplate(row: TemplateRecord | Tombstone): SyncTemplateChange {
  return 'deletedAt' in row ? row : { ...row, params: { ...row.params } as Record<string, unknown> }
}

/** `imageId` 是封面，带给 `views` 之前的服务端与其它设备；本机侧不存它。 */
function toWireAsset(row: AssetRecord | Tombstone): SyncAssetChange {
  return 'deletedAt' in row ? row : { ...row, imageId: assetCoverImageId(row) }
}

/** 服务端旧行没有 `views`，读回来仍是一张视角。 */
function fromWireAsset(change: SyncAssetChange): AssetRecord | Tombstone {
  if (isSyncTombstone(change)) return change
  const { imageId, views, ...rest } = change as SyncAssetRecord
  return {
    ...rest,
    kind: rest.kind as AssetRecord['kind'],
    background: rest.background as AssetRecord['background'],
    views:
      views && views.length > 0
        ? views.map((view) => ({
            imageId: view.imageId,
            label: view.label as AssetView['label'],
            source: view.source as AssetView['source'],
          }))
        : [{ imageId, label: 'none', source: 'upload' }],
  }
}

/** 一次请求最多带走这么多，其余留在待推集合里等下一轮。 */
function collect<T extends { id: string }>(
  rows: Array<T | Tombstone>,
  pendingIds: readonly string[],
): Array<T | Tombstone> {
  const wanted = new Set(pendingIds)
  return rows.filter((row) => wanted.has(row.id)).slice(0, SYNC_MAX_CHANGES_PER_COLLECTION)
}

/** 这一轮真要传的图与它们的进度；同一张图被几条记录引用只算一次。 */
interface UploadProgress {
  readonly queued: Set<string>
  readonly total: number
  done: number
}

function plannedUploads(hiding: boolean, imageIds: readonly string[]): UploadProgress {
  const queued = hiding
    ? new Set<string>()
    : new Set(imageIds.filter((id) => !isAssetImageOnServer(id)))
  const progress: UploadProgress = { queued, total: queued.size, done: 0 }
  reportAssetUploads(0, progress.total)
  return progress
}

/**
 * 先图后记录：服务端只收图片本体已经全部在它那边的记录。图还没传上去的这一轮不推，
 * 留在待推集合里等下一轮；服务端明确不收的（配额、类型）摘出待推集合，改标「未同步」，
 * 本机根本没有图片本体的也摘出去，等取图路径取回图片再入。
 */
async function withImagesUploaded<T extends { id: string }>(
  collection: SyncCollection,
  changes: Array<T | Tombstone>,
  imagesOf: (record: T) => string[],
  hiding: boolean,
  progress: UploadProgress,
): Promise<Array<T | Tombstone>> {
  const ready: Array<T | Tombstone> = []
  const refused: string[] = []
  // 逐张传，不并发：首次登录那一批素材会把几百张图一起推出去。
  for (const change of changes) {
    if (isSyncTombstone(change)) {
      ready.push(change)
      continue
    }
    const imageIds = imagesOf(change)
    // 页面正在隐藏：等图片传完，这一轮元数据就跟着页面一起没了。
    if (hiding) {
      if (imageIds.every(isAssetImageOnServer)) ready.push(change)
      continue
    }
    const outcomes: AssetImageUpload[] = []
    for (const imageId of imageIds) {
      const counted = progress.queued.delete(imageId)
      outcomes.push(await uploadAssetImage(imageId))
      if (counted) {
        progress.done += 1
        reportAssetUploads(progress.done, progress.total)
      }
    }
    // 一条记录的图缺一张都推不动，所以取最坏的那一张作判。
    if (outcomes.includes('refused')) refused.push(change.id)
    // 当场撤下：攒到循环末尾再撤，会把这期间取图路径刚取回图片、刚重标脏的记录一并撤掉。
    else if (outcomes.includes('imageless')) withholdImagelessRecords(collection, [change.id])
    else if (outcomes.every((one) => one === 'uploaded')) ready.push(change)
  }
  if (refused.length > 0) dropPendingRecords(collection, refused)
  return ready
}

async function applyResponse(response: SyncResponseBody): Promise<void> {
  const assets = response.assets.map(fromWireAsset)
  for (const change of assets) {
    if (isSyncTombstone(change)) continue
    for (const imageId of assetImageIds(change)) noteAssetImageOnServer(imageId)
  }
  for (const change of response.looks) {
    if (isSyncTombstone(change)) continue
    for (const imageId of lookImageIds(change as LookRecord)) noteAssetImageOnServer(imageId)
  }
  await Promise.all([
    templateStore.applyRemote(response.templates as Array<TemplateRecord | Tombstone>),
    assetStore.applyRemote(assets),
    lookStore.applyRemote(response.looks as Array<LookRecord | Tombstone>),
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
    response.looks.length > 0 ? library.loadLooks() : null,
  ])
}

/** 清账：推上去的从待推集合里划掉，被拒的和飞行期间又改过的留下。 */
function settle(request: SyncRequestBody, response: SyncResponseBody): void {
  // 服务端那边也没有这张图：留在待推集合里只会一轮轮重推同一条。
  for (const rejection of response.rejected) {
    if (rejection.reason === 'asset_image_missing') {
      withholdImagelessRecords(rejection.collection, [rejection.id])
    }
  }
  const rejected = new Set(response.rejected.map((rejection) => rejection.id))
  const keep = (collection: SyncCollection) => {
    const sent = new Set(request[collection]?.map((change) => change.id))
    return (id: string) =>
      !sent.has(id) || rejected.has(id) || (changedInFlight?.has(`${collection}:${id}`) ?? false)
  }

  const current = readPendingChanges()
  const next: SyncCheckpoint = {
    ...current,
    version: response.version,
    templates: current.templates.filter(keep('templates')),
    assets: current.assets.filter(keep('assets')),
    looks: current.looks.filter(keep('looks')),
    settingsUpdatedAt:
      request.settings && !changedInFlight?.has('settings') ? null : current.settingsUpdatedAt,
    lastSyncedAt: Date.now(),
  }
  writePendingChanges(next)
}
