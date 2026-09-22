/**
 * 同步协议（`POST /api/sync`）：一次请求既推也拉。合并规则只在服务端存在一份，
 * 客户端无条件用响应里的记录覆盖本地。
 */

import { IMAGE_MIME_TYPES } from './image'

export const SYNC_MAX_CHANGES_PER_COLLECTION = 500
export const SYNC_NAME_MAX_LENGTH = 200
export const SYNC_PROMPT_MAX_LENGTH = 20_000
export const SYNC_ID_MAX_LENGTH = 128
export const SYNC_TEMPLATE_ASSET_IDS_MAX = 32
export const SYNC_SETTINGS_MAX_BYTES = 64_000
export const SYNC_TEMPLATE_PARAMS_MAX_BYTES = 8_000
export const SYNC_ASSET_VIEWS_MAX = 32
export const SYNC_LOOK_BODY_MAX_LENGTH = 20_000
export const SYNC_LOOK_DESCRIPTION_MAX_LENGTH = 500
export const SYNC_LOOK_REFERENCE_IMAGES_MAX = 16
export const SYNC_LOOK_SLOT_COUNT_MAX = 8

/** 同步集合：本机表名、协议字段名与服务端表名共用这一组字面量。 */
export type SyncCollection = 'templates' | 'assets' | 'looks'

/** 素材与模板的取值表。界面用的联合类型由它们派生，枚举只在这里存一份。 */
export const ASSET_KINDS = ['product', 'person'] as const
export const ASSET_BACKGROUNDS = ['transparent', 'solid'] as const
export const ASSET_VIEW_LABELS = ['front', 'side', 'back', 'detail', 'sheet', 'none'] as const
export const ASSET_VIEW_SOURCES = ['upload', 'generated'] as const
export const LOOK_PURPOSES = ['hero', 'poster', 'scene', 'detail'] as const

export const SYNC_ASSET_IMAGE_MIME_TYPES = IMAGE_MIME_TYPES
/** `imageId` 是内容哈希，字符集限制同时挡住对象键穿越。 */
export const SYNC_IMAGE_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** 两项素材图配额的拒绝码，各自对应 `quota` 命名空间里的一个 key。 */
export type SyncAssetQuotaErrorCode = 'asset_image_too_large' | 'asset_storage_quota_exceeded'

export interface SyncAssetQuotaError {
  readonly error: SyncAssetQuotaErrorCode
  /** 触发拒绝的那一项上限，字节。 */
  readonly limit: number
}

export interface SyncAssetUploadResult {
  readonly imageId: string
  readonly bytes: number
  /** 该用户已用的素材图总字节，含本次。 */
  readonly totalBytes: number
}

/** 删掉的记录在同步里的样子；`deletedAt` 的有无就是墓碑与实体记录的判据。 */
export interface SyncTombstone {
  readonly id: string
  readonly updatedAt: number
  readonly deletedAt: number
}

export interface SyncTemplateRecord {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly assetIds: readonly (string | null)[]
  readonly params: Record<string, unknown>
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number
}

/** 素材的一个视角：一张图加它的视角标签与来源。 */
export interface SyncAssetView {
  readonly imageId: string
  readonly label: string
  readonly source: string
}

export interface SyncAssetRecord {
  readonly id: string
  readonly name: string
  /** 封面视角的图片 id。`views` 之前的客户端只认这一个字段，所以它一直带着。 */
  readonly imageId: string
  readonly kind?: string
  readonly background?: string
  /** 缺席 = `views` 之前的客户端推上来的，服务端按封面补成一张视角。 */
  readonly views?: readonly SyncAssetView[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number
}

/** 模板（`look`）：一份技能正文加它钉死的模型、尺寸、素材位与图片。 */
export interface SyncLookRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly purpose: string
  readonly body: string
  readonly model: string
  readonly size: string
  readonly slotCount: number
  readonly referenceImageIds: readonly string[]
  readonly coverImageId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number
}

export type SyncTemplateChange = SyncTemplateRecord | SyncTombstone
export type SyncAssetChange = SyncAssetRecord | SyncTombstone
export type SyncLookChange = SyncLookRecord | SyncTombstone

/** 一条记录要占的素材图：素材是全部视角，模板是参考图加封面。 */
export function syncAssetImageIds(record: SyncAssetRecord): string[] {
  const views = record.views?.map((view) => view.imageId) ?? []
  return [...new Set([record.imageId, ...views])]
}

export function syncLookImageIds(record: SyncLookRecord): string[] {
  const ids = [...record.referenceImageIds]
  if (record.coverImageId) ids.push(record.coverImageId)
  return [...new Set(ids)]
}

/** 用户设置整份存取，不做字段级合并。 */
export interface SyncSettingsDocument {
  readonly updatedAt: number
  readonly document: Record<string, unknown>
}

export interface SyncRequestBody {
  readonly version: number
  readonly templates?: readonly SyncTemplateChange[]
  readonly assets?: readonly SyncAssetChange[]
  readonly looks?: readonly SyncLookChange[]
  readonly settings?: SyncSettingsDocument | null
}

export type SyncRejectionReason = 'asset_image_missing' | 'quota_exceeded'

export interface SyncRejection {
  readonly collection: SyncCollection
  readonly id: string
  readonly reason: SyncRejectionReason
}

export interface SyncResponseBody {
  readonly version: number
  readonly templates: readonly SyncTemplateChange[]
  readonly assets: readonly SyncAssetChange[]
  readonly looks: readonly SyncLookChange[]
  readonly settings: SyncSettingsDocument | null
  readonly rejected: readonly SyncRejection[]
}

export function isSyncTombstone<T extends { id: string }>(
  change: T | SyncTombstone,
): change is SyncTombstone {
  return typeof (change as SyncTombstone).deletedAt === 'number'
}
