import { SCOPED_LOCAL_STORAGE_KEYS, safeLocalStorage, scopedStorageName } from './authScope'
import { BASE_DB_NAME, DB_STORE_NAMES, type DbStoreName, openNamedDb } from './db'

/** 认领完成的标记，跨 scope 共用。不支持 indexedDB.databases() 的浏览器靠它避免每次启动重扫。 */
const ADOPTION_DONE_KEY = `${BASE_DB_NAME}:adopted`

// 图片是整张 data URL，一次全读进内存会在大库上炸掉标签页；任务行小得多，不必切这么碎。
const BATCH_SIZE: Record<DbStoreName, number> = {
  tasks: 200,
  images: 10,
  thumbnails: 50,
  assets: 200,
}

let adoption: Promise<number> | null = null

/**
 * 把匿名 scope 的历史合并进当前登录用户的 scope，返回新认领的任务条数。
 * 合并不覆盖，整体搬完才删源，所以中断后下次启动能接着来。
 */
export function adoptAnonymousStorage(): Promise<number> {
  adoption ??= runAdoption().catch((error) => {
    console.error('[storage-adoption] 认领匿名历史失败', error)
    return 0
  })
  return adoption
}

async function runAdoption(): Promise<number> {
  const scopedDbName = scopedStorageName(BASE_DB_NAME)
  // 匿名 scope 下源库就是活动库，没有可认领的东西。
  if (scopedDbName === BASE_DB_NAME) return 0
  if (typeof indexedDB === 'undefined') return 0
  if (safeLocalStorage.getItem(ADOPTION_DONE_KEY) !== null) return 0
  if (!(await anonymousDbMayExist())) return 0

  const source = await openNamedDb(BASE_DB_NAME)
  let target: IDBDatabase | null = null
  let adoptedTasks = 0
  try {
    target = await openNamedDb(scopedDbName)
    for (const storeName of DB_STORE_NAMES) {
      const copied = await copyStore(source, target, storeName)
      if (storeName === 'tasks') adoptedTasks = copied
    }
    adoptLocalStorage()
  } finally {
    target?.close()
    source.close()
  }

  // 删除被其它标签页 block 时留着源库，下次启动重跑：跳过已存在的 key，幂等。
  if (await deleteAnonymousDb()) {
    safeLocalStorage.setItem(ADOPTION_DONE_KEY, '1')
    for (const key of SCOPED_LOCAL_STORAGE_KEYS) safeLocalStorage.removeItem(key)
  }
  return adoptedTasks
}

/** databases() 缺席时返回 true：调用方打开源库去数，顺手建出来的空库会在结尾被删掉。 */
async function anonymousDbMayExist(): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') return true
  try {
    const databases = await indexedDB.databases()
    return databases.some((database) => database.name === BASE_DB_NAME)
  } catch {
    return true
  }
}

async function copyStore(
  source: IDBDatabase,
  target: IDBDatabase,
  storeName: DbStoreName,
): Promise<number> {
  const sourceKeys = await getAllKeys(source, storeName)
  if (sourceKeys.length === 0) return 0

  // 先按 key 排掉重复，免得把目标已有的图片（整张 data URL）白读一遍进内存。
  const existing = new Set((await getAllKeys(target, storeName)).map(String))
  const missing = sourceKeys.filter((key) => !existing.has(String(key)))

  const batchSize = BATCH_SIZE[storeName]
  let copied = 0
  for (let index = 0; index < missing.length; index += batchSize) {
    const batch = missing.slice(index, index + batchSize)
    copied += await addRecords(target, storeName, await readRecords(source, storeName, batch))
  }
  return copied
}

/** body 返回一个取值函数：request.result 要等事务 complete 之后再读。 */
function runTransaction<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const read = body(tx.objectStore(storeName))
    tx.oncomplete = () => resolve(read())
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error(`认领历史的 ${storeName} 事务被中止`))
  })
}

function getAllKeys(db: IDBDatabase, storeName: string): Promise<IDBValidKey[]> {
  return runTransaction(db, storeName, 'readonly', (store) => {
    const request = store.getAllKeys()
    return () => request.result
  })
}

function readRecords(db: IDBDatabase, storeName: string, keys: IDBValidKey[]): Promise<unknown[]> {
  return runTransaction(db, storeName, 'readonly', (store) => {
    const requests = keys.map((key) => store.get(key))
    return () => requests.map((request) => request.result).filter((record) => record !== undefined)
  })
}

function addRecords(db: IDBDatabase, storeName: string, records: unknown[]): Promise<number> {
  return runTransaction(db, storeName, 'readwrite', (store) => {
    let written = 0
    for (const record of records) {
      const request = store.add(record)
      request.onsuccess = () => {
        written += 1
      }
      request.onerror = (event) => {
        // 目标已有同 id：跳过而不是让整个事务连带回滚。其余错误（配额耗尽等）
        // 必须放行去中止事务，否则会漏记录提交，随后源库就被删了。
        if (request.error?.name !== 'ConstraintError') return
        event.preventDefault()
        event.stopPropagation()
      }
    }
    return () => written
  })
}

/** 已登录用户自己的设置永远优先，只补目标 scope 还没有的 key。 */
function adoptLocalStorage(): void {
  for (const key of SCOPED_LOCAL_STORAGE_KEYS) {
    const anonymous = safeLocalStorage.getItem(key)
    if (anonymous === null) continue
    const scopedKey = scopedStorageName(key)
    if (safeLocalStorage.getItem(scopedKey) !== null) continue
    safeLocalStorage.setItem(scopedKey, anonymous)
  }
}

function deleteAnonymousDb(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BASE_DB_NAME)
    // 旧标签页还占着连接：不等它，本次不删，下次启动再来。
    request.onblocked = () => resolve(false)
    request.onsuccess = () => resolve(true)
    request.onerror = () => reject(request.error)
  })
}
