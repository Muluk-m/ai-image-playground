import { create } from 'zustand'

export type SyncStatus = 'idle' | 'syncing' | 'error'

interface SyncStatusState {
  /** 引擎有没有在跑。关闭的部署里 UI 一个字都不出。 */
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
