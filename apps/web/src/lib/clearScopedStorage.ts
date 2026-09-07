import { SCOPED_LOCAL_STORAGE_KEYS, safeLocalStorage, scopedStorageName } from './authScope'
import { BASE_DB_NAME, DB_STORE_NAMES, openNamedDb } from './db'

/**
 * 退出登录时的「同时清除本机数据」。匿名 scope 的库名与 key 没有后缀，清它会连带抹掉
 * 未登录访客的数据，所以 scope 是匿名时直接不做。
 */
export async function clearScopedClientStorage(): Promise<void> {
  const dbName = scopedStorageName(BASE_DB_NAME)
  if (dbName === BASE_DB_NAME) return

  for (const key of SCOPED_LOCAL_STORAGE_KEYS) safeLocalStorage.removeItem(scopedStorageName(key))
  if (typeof indexedDB === 'undefined') return

  // 清表而不是 deleteDatabase：db.ts 每次事务开一条连接且不关，删库会一直卡在 blocked。
  const db = await openNamedDb(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...DB_STORE_NAMES], 'readwrite')
      for (const storeName of DB_STORE_NAMES) tx.objectStore(storeName).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
