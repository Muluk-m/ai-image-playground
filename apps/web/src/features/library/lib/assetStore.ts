import { dbTransaction, STORE_ASSETS } from '../../../lib/db'
import type { AssetRecord } from '../types'

/** 素材存储后端。服务端实现替换 assetStore 这一个绑定即可。 */
export interface AssetStore {
  list(): Promise<AssetRecord[]>
  put(asset: AssetRecord): Promise<void>
  remove(id: string): Promise<void>
}

export const assetStore: AssetStore = {
  list: () => dbTransaction<AssetRecord[]>(STORE_ASSETS, 'readonly', (s) => s.getAll()),
  put: (asset) => dbTransaction(STORE_ASSETS, 'readwrite', (s) => s.put(asset)).then(() => {}),
  remove: (id) => dbTransaction(STORE_ASSETS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
