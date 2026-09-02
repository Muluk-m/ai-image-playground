import { safeLocalStorage, scopedStorageName } from './authScope'
import { BASE_DB_NAME, DB_STORE_NAMES, openNamedDb } from './db'

/**
 * 打开 `accounts:login` 之前，历史存在匿名命名空间下；打开之后 scope 变成
 * `:user-<id>`，旧历史就此不可见。每次启动认领一次匿名命名空间：合并而非覆盖，
 * 完整搬完才删源，所以中断后下次启动能接着来。
 */

/** scopedLocalStorage 作用到的全部 key，目前只有 store 的 persist name（store.ts）。 */
const SCOPED_LOCAL_STORAGE_KEYS = ['image-playground']

// 图片是整张 data URL，一次全读进内存会在大库上炸掉标签页，按批搬。
const COPY_BATCH_SIZE = 10

let adoption: Promise<number> | null = null
let pendingAdoptedTaskCount = 0

/**
 * 把匿名命名空间的历史合并进当前登录用户的命名空间。返回新认领的任务条数。
 * 必须在 store 首次加载（读 IndexedDB 与 persist key）之前 await。
 */
export function adoptAnonymousStorage(): Promise<number> {
  adoption ??= runAdoption().catch((error) => {
    console.error('[storage-adoption] 认领匿名历史失败', error)
    return 0
  })
  return adoption
}

/** 认领的任务条数，取走即清零；由 App 挂载后弹一次 toast。 */
export function takeAdoptedTaskCount(): number {
  const count = pendingAdoptedTaskCount
  pendingAdoptedTaskCount = 0
  return count
}

async function runAdoption(): Promise<number> {
  const scopedDbName = scopedStorageName(BASE_DB_NAME)
  // 匿名 scope 下源库就是活动库，没有可认领的东西。
  if (scopedDbName === BASE_DB_NAME) return 0
  if (typeof indexedDB === 'undefined') return 0
  if (!(await anonymousDbMayExist())) return 0

  const source = await openNamedDb(BASE_DB_NAME)
  let adoptedTasks = 0
  try {
    const target = await openNamedDb(scopedDbName)
    try {
      for (const storeName of DB_STORE_NAMES) {
        const copied = await copyStore(source, target, storeName)
        if (storeName === 'tasks') adoptedTasks = copied
      }
    } finally {
      target.close()
    }
    adoptLocalStorage()
  } finally {
    source.close()
  }

  // 搬完才删：删除被别的标签页 block 时留着源库，下次启动重跑（跳过已存在的 key，幂等）。
  if (await deleteAnonymousDb()) {
    for (const key of SCOPED_LOCAL_STORAGE_KEYS) safeLocalStorage.removeItem(key)
  }

  pendingAdoptedTaskCount += adoptedTasks
  return adoptedTasks
}

/**
 * `indexedDB.databases()` 不可用时返回 true：由调用方打开源库数记录，
 * 顺手建出来的空库会在结尾被删掉。
 */
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
  storeName: string,
): Promise<number> {
  const sourceKeys = await getAllKeys(source, storeName)
  if (sourceKeys.length === 0) return 0

  const existing = new Set((await getAllKeys(target, storeName)).map(String))
  const missing = sourceKeys.filter((key) => !existing.has(String(key)))

  let copied = 0
  for (let index = 0; index < missing.length; index += COPY_BATCH_SIZE) {
    const batch = missing.slice(index, index + COPY_BATCH_SIZE)
    copied += await addRecords(target, storeName, await readRecords(source, storeName, batch))
  }
  return copied
}

function getAllKeys(db: IDBDatabase, storeName: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readRecords(db: IDBDatabase, storeName: string, keys: IDBValidKey[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const records: unknown[] = []
    for (const key of keys) {
      const request = store.get(key)
      request.onsuccess = () => {
        if (request.result !== undefined) records.push(request.result)
      }
    }
    tx.oncomplete = () => resolve(records)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('读取匿名历史的事务被中止'))
  })
}

function addRecords(db: IDBDatabase, storeName: string, records: unknown[]): Promise<number> {
  if (records.length === 0) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    let written = 0
    for (const record of records) {
      const request = store.add(record)
      request.onsuccess = () => {
        written += 1
      }
      // 目标已有同 id：跳过而不是让整个事务连带回滚。
      request.onerror = (event) => {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    tx.oncomplete = () => resolve(written)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('写入认领历史的事务被中止'))
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
