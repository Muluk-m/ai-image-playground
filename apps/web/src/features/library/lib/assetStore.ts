import { accountScope } from '../../../lib/authScope'
import { dbTransaction, STORE_ASSETS } from '../../../lib/db'
import { markRecordDirty } from '../../../lib/sync/pending'
import type { AssetRecord, AssetView, Tombstone } from '../types'
import { createRecordStore } from './recordStore'

export const assetStore = createRecordStore<AssetRecord>(STORE_ASSETS, (asset) =>
  asset.views.map((view) => view.imageId),
)

/** Read and change in one transaction so concurrent metadata edits cannot discard a new view. */
export async function updateAssetRecord(
  assetId: string,
  change: (asset: AssetRecord) => AssetRecord,
  canWrite: () => boolean = () => true,
): Promise<AssetRecord | null> {
  const current = accountScope()
  const result: { asset: AssetRecord | null } = { asset: null }
  await dbTransaction(STORE_ASSETS, 'readwrite', (store) => {
    const request = store.get(assetId)
    request.addEventListener('success', () => {
      const row = request.result as AssetRecord | Tombstone | undefined
      if (!current() || !canWrite() || !row || 'deletedAt' in row) return
      result.asset = change(row)
      store.put(result.asset)
    })
    return request
  })
  if (!current() || !result.asset) return null
  markRecordDirty(STORE_ASSETS, {
    id: assetId,
    imageIds: result.asset.views.map((one) => one.imageId),
  })
  return result.asset
}

export function appendGeneratedAssetView(
  assetId: string,
  view: AssetView,
  canWrite?: () => boolean,
): Promise<AssetRecord | null> {
  return updateAssetRecord(
    assetId,
    (row) => ({
      ...row,
      views: [
        row.views.find((one) => one.imageId === view.imageId) ?? view,
        ...row.views.filter((one) => one.imageId !== view.imageId),
      ],
      updatedAt: Math.max(Date.now(), row.updatedAt + 1),
    }),
    canWrite,
  )
}
