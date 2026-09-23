import { create } from 'zustand'

export type SyncStatus = 'idle' | 'syncing' | 'error'

/**
 * 失败到底是哪一类。只写两个字「保存失败」时用户无从下手：会话过期要重新登录、
 * 链路不通要等网络、服务端拒绝要看内容，三件事的处置完全不同。
 */
export type SyncFailure = 'unauthorized' | 'network' | 'rejected'

/** 一轮里要上传的素材图张数与已传张数。 */
export interface AssetUploadProgress {
  done: number
  total: number
}

interface SyncStatusState {
  /** 引擎有没有在跑。关闭的部署里 UI 一个字都不出。 */
  enabled: boolean
  status: SyncStatus
  pending: number
  lastSyncedAt: number | null
  /** 服务端不会再收的素材图；引用它们的素材卡标「未同步」。 */
  unsyncedImages: string[]
  /** null = 这一轮没有图要传。 */
  uploads: AssetUploadProgress | null
  /** 只有 `status === 'error'` 时有值。 */
  failure: SyncFailure | null
}

export const useSyncStatus = create<SyncStatusState>(() => ({
  enabled: false,
  status: 'idle',
  pending: 0,
  lastSyncedAt: null,
  unsyncedImages: [],
  uploads: null,
  failure: null,
}))

export function reportAssetUploads(done: number, total: number): void {
  useSyncStatus.setState({ uploads: total === 0 ? null : { done, total } })
}
