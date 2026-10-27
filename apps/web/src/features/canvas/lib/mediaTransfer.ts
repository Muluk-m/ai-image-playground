import { create } from 'zustand'
import { i18next } from '../../../i18n'
import { useStore } from '../../../store'
import { type CanvasExportResult, downloadMediaBundle, type MediaBundleEntry } from './exportImages'

export type MediaTransferStatus = 'waiting' | 'packing' | 'finished' | 'failed'

export interface MediaTransfer {
  readonly id: number
  readonly fileName: string
  readonly status: MediaTransferStatus
  /** 0–1，已经取到的条目占比。 */
  readonly progress: number
}

interface MediaTransferState {
  readonly transfer: MediaTransfer | null
  dismiss(): void
}

let nextId = 0

export const useMediaTransferStore = create<MediaTransferState>((set) => ({
  transfer: null,
  dismiss: () => set({ transfer: null }),
}))

function patch(id: number, next: Partial<MediaTransfer>) {
  useMediaTransferStore.setState((state) =>
    state.transfer?.id === id ? { transfer: { ...state.transfer, ...next } } : state,
  )
}

function report(result: CanvasExportResult) {
  const { showToast } = useStore.getState()
  if (result.exported === 0) showToast(i18next.t('batch.exportFailed', { ns: 'canvas' }), 'error')
  else if (result.failed > 0)
    showToast(
      i18next.t('batch.exportPartial', {
        ns: 'canvas',
        count: result.exported,
        failed: result.failed,
      }),
      'info',
    )
}

function allFailed(entries: readonly MediaBundleEntry[]): CanvasExportResult {
  return { exported: 0, failed: entries.length }
}

/**
 * 下载一组作品。一件直接落盘；多件打成 `<项目名>_<n>项.zip`，底部传输卡片跟着走
 * 等待中 → 打包中 → 已完成。部分或全部取不到时另给一条提示。
 */
export async function transferMedia(
  entries: readonly MediaBundleEntry[],
  projectName: string,
): Promise<CanvasExportResult> {
  if (entries.length < 2) {
    const result = await downloadMediaBundle(entries).catch(() => allFailed(entries))
    if (entries.length) report(result)
    return result
  }
  const id = ++nextId
  const baseName = i18next.t('assetsPanel.transfer.zipName', {
    ns: 'canvas',
    name: projectName.trim() || 'Muvloom',
    count: entries.length,
  })
  useMediaTransferStore.setState({
    transfer: { id, fileName: `${baseName}.zip`, status: 'waiting', progress: 0 },
  })
  // 单条取不到由 downloadMediaBundle 自己记成 failed；打包或落盘本身出错也收成「失败」，卡片不会停在打包中。
  const result = await downloadMediaBundle(entries, {
    baseName,
    onProgress: (done, total) => patch(id, { status: 'packing', progress: done / total }),
  }).catch(() => allFailed(entries))
  patch(id, { status: result.exported ? 'finished' : 'failed', progress: 1 })
  report(result)
  return result
}
