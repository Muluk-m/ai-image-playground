import { dbTransaction } from '../../../lib/db'
import type { Tombstone } from '../types'

/** 素材 / 模板共用的记录存储后端。服务端实现替换调用方的那一个绑定即可。 */
export interface RecordStore<T> {
  list(): Promise<T[]>
  put(record: T): Promise<void>
  remove(id: string): Promise<void>
}

export function createRecordStore<T extends { id: string }>(storeName: string): RecordStore<T> {
  return {
    list: async () => {
      const rows = await dbTransaction<Array<T | Tombstone>>(storeName, 'readonly', (store) =>
        store.getAll(),
      )
      return rows.filter((row): row is T => !isTombstone(row))
    },

    put: (record) =>
      dbTransaction(storeName, 'readwrite', (store) => store.put(record)).then(() => {}),

    // 删除写墓碑而不是抹掉行，否则另一台设备推来的旧版本会让它复活。
    remove: async (id) => {
      const now = Date.now()
      const tombstone: Tombstone = { id, updatedAt: now, deletedAt: now }
      await dbTransaction(storeName, 'readwrite', (store) => store.put(tombstone))
    },
  }
}

function isTombstone(row: unknown): row is Tombstone {
  return typeof (row as Tombstone).deletedAt === 'number'
}
