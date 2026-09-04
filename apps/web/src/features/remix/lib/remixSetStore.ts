import { dbTransaction, STORE_REMIX_SETS } from '../../../lib/db'
import type { RemixSetRecord } from '../types'

/** 套存储后端。服务端实现替换 remixSetStore 这一个绑定即可。 */
export interface RemixSetStore {
  list(): Promise<RemixSetRecord[]>
  put(set: RemixSetRecord): Promise<void>
  remove(id: string): Promise<void>
}

export const remixSetStore: RemixSetStore = {
  list: () => dbTransaction<RemixSetRecord[]>(STORE_REMIX_SETS, 'readonly', (s) => s.getAll()),
  put: (set) => dbTransaction(STORE_REMIX_SETS, 'readwrite', (s) => s.put(set)).then(() => {}),
  remove: (id) => dbTransaction(STORE_REMIX_SETS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
