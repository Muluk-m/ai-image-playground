import { SCOPED_LOCAL_STORAGE_KEYS, safeLocalStorage, scopedStorageName } from './authScope'
import { BASE_DB_NAME, DB_STORE_NAMES, dbTransaction } from './db'

/**
 * 退出登录时的「同时清除本机数据」。匿名 scope 的库名与 key 没有后缀，清它会连带抹掉
 * 未登录访客的数据，所以 scope 是匿名时直接不做。
 */
export async function clearScopedClientStorage(): Promise<void> {
  if (scopedStorageName(BASE_DB_NAME) === BASE_DB_NAME) return

  for (const key of SCOPED_LOCAL_STORAGE_KEYS) safeLocalStorage.removeItem(scopedStorageName(key))
  if (typeof indexedDB === 'undefined') return

  // 清表而不是 deleteDatabase：dbTransaction 每次开一条连接且不关，删库会一直卡在 blocked。
  await Promise.all(
    DB_STORE_NAMES.map((storeName) =>
      dbTransaction(storeName, 'readwrite', (store) => store.clear()),
    ),
  )
}
