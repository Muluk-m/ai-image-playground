import { dbTransaction, STORE_REMIX_SETS } from '../../../lib/db'
import type { RemixSetRecord } from '../types'

/** 套存储后端。服务端实现替换 remixSetStore 这一个绑定即可。 */
export interface RemixSetStore {
  list(): Promise<RemixSetRecord[]>
  put(set: RemixSetRecord): Promise<void>
  remove(id: string): Promise<void>
}

/** 结构对不上的旧记录直接跳过：读出来只会在下游炸，没有可迁移的内容。 */
function isCurrentShape(record: RemixSetRecord): boolean {
  return (
    Array.isArray(record.source?.sourceImageIds) &&
    record.shots.every((shot) => Array.isArray(shot.taskIds))
  )
}

export const remixSetStore: RemixSetStore = {
  list: () =>
    dbTransaction<RemixSetRecord[]>(STORE_REMIX_SETS, 'readonly', (s) => s.getAll()).then((sets) =>
      sets.filter(isCurrentShape),
    ),
  put: (set) => dbTransaction(STORE_REMIX_SETS, 'readwrite', (s) => s.put(set)).then(() => {}),
  remove: (id) => dbTransaction(STORE_REMIX_SETS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
