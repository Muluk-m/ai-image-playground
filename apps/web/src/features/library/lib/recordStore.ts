import { dbTransaction } from '../../../lib/db'
import { markRecordDirty, type SyncCollection } from '../../../lib/sync/pending'
import type { Tombstone } from '../types'

/** 同步集合（素材 / 模板）的记录存储后端。本机数据的表照旧硬删，不要绑到这里。 */
export interface RecordStore<T> {
  list(): Promise<T[]>
  /** 含墓碑的整表，推送时用；读路径一律走 `list`。 */
  listChanges(): Promise<Array<T | Tombstone>>
  put(record: T): Promise<void>
  remove(id: string): Promise<void>
  /** 服务端回传：无条件覆盖，且不标脏——标了会把刚拉下来的记录原样推回去。 */
  applyRemote(changes: Array<T | Tombstone>): Promise<void>
}

export function createRecordStore<T extends { id: string }>(
  storeName: SyncCollection,
): RecordStore<T> {
  const write = (record: T | Tombstone) =>
    dbTransaction(storeName, 'readwrite', (store) => store.put(record)).then(() => {})
  const listChanges = () =>
    dbTransaction<Array<T | Tombstone>>(storeName, 'readonly', (store) => store.getAll())

  return {
    listChanges,

    list: async () => (await listChanges()).filter((row): row is T => !isTombstone(row)),

    put: async (record) => {
      await write(record)
      markRecordDirty(storeName, record)
    },

    // 删除写墓碑而不是抹掉行，否则另一台设备推来的旧版本会让它复活。
    remove: async (id) => {
      const now = Date.now()
      const tombstone = { id, updatedAt: now, deletedAt: now }
      await write(tombstone)
      markRecordDirty(storeName, tombstone)
    },

    applyRemote: async (changes) => {
      for (const change of changes) await write(change)
    },
  }
}

function isTombstone(row: unknown): row is Tombstone {
  return typeof (row as Tombstone).deletedAt === 'number'
}
