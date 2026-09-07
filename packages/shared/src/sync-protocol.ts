/**
 * 同步协议（`POST /api/sync`）：一次请求既推也拉。合并规则只在服务端存在一份，
 * 客户端无条件用响应里的记录覆盖本地。
 */

export const SYNC_MAX_CHANGES_PER_COLLECTION = 500
export const SYNC_NAME_MAX_LENGTH = 200
export const SYNC_PROMPT_MAX_LENGTH = 20_000
export const SYNC_ID_MAX_LENGTH = 128
export const SYNC_TEMPLATE_ASSET_IDS_MAX = 32
export const SYNC_SETTINGS_MAX_BYTES = 64_000
export const SYNC_TEMPLATE_PARAMS_MAX_BYTES = 8_000

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

export interface SyncAssetRecord {
  readonly id: string
  readonly name: string
  readonly imageId: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number
}

export type SyncTemplateChange = SyncTemplateRecord | SyncTombstone
export type SyncAssetChange = SyncAssetRecord | SyncTombstone

/** 用户设置整份存取，不做字段级合并。 */
export interface SyncSettingsDocument {
  readonly updatedAt: number
  readonly document: Record<string, unknown>
}

export interface SyncRequestBody {
  readonly version: number
  readonly templates?: readonly SyncTemplateChange[]
  readonly assets?: readonly SyncAssetChange[]
  readonly settings?: SyncSettingsDocument | null
}

export type SyncRejectionReason = 'asset_image_missing' | 'quota_exceeded'

export interface SyncRejection {
  readonly collection: 'templates' | 'assets'
  readonly id: string
  readonly reason: SyncRejectionReason
}

export interface SyncResponseBody {
  readonly version: number
  readonly templates: readonly SyncTemplateChange[]
  readonly assets: readonly SyncAssetChange[]
  readonly settings: SyncSettingsDocument | null
  readonly rejected: readonly SyncRejection[]
}

export function isSyncTombstone<T extends { id: string }>(
  change: T | SyncTombstone,
): change is SyncTombstone {
  return typeof (change as SyncTombstone).deletedAt === 'number'
}
