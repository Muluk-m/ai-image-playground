import { dbTransaction, STORE_ASSETS } from '../../../lib/db'
import type { AssetRecord } from '../types'

/** 素材存储后端。换服务端实现只需替换下面 assetStore 的绑定。 */
export interface AssetStore {
  list(): Promise<AssetRecord[]>
  put(asset: AssetRecord): Promise<void>
  remove(id: string): Promise<void>
}

const localAssetStore: AssetStore = {
  list: () => dbTransaction<AssetRecord[]>(STORE_ASSETS, 'readonly', (s) => s.getAll()),
  put: (asset) => dbTransaction(STORE_ASSETS, 'readwrite', (s) => s.put(asset)).then(() => {}),
  remove: (id) => dbTransaction(STORE_ASSETS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}

export const assetStore: AssetStore = localAssetStore
