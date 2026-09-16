import type { Camera, CanvasEl } from './canvasDoc'
import type { CanvasEditor } from './editor'

/**
 * 画布场景的 IndexedDB 持久化。与项目 image-playground 主库隔离，独立 DB；
 * 每个会话独立保存场景；旧单场景留作迁移备份。
 */
const DB_NAME = 'image-playground-canvas'
const DB_VERSION = 1
const STORE = 'scene'
const SCENE_KEY = 'scene'
const SCENE_FORMAT = 2

/** 变更高频触发（拖拽 / 画笔每帧都算），落盘防抖窗口。 */
export const PERSIST_DEBOUNCE_MS = 500

interface PersistedScene {
  version: typeof SCENE_FORMAT
  elements: readonly CanvasEl[]
  /** fileId → dataUrl，只存仍被引用的。 */
  files: Record<string, string>
  camera: Camera
}

/** 连接缓存：防抖落盘高频调用，每次新开连接会积累未关闭句柄。失败/被关则下次重开。 */
let dbPromise: Promise<IDBDatabase> | null = null

export function openCanvasDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        req.result.onclose = () => {
          dbPromise = null
        }
        resolve(req.result)
      }
      req.onerror = () => reject(req.error)
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function dbGet(key: string, migrateLegacy: boolean): Promise<unknown> {
  return openCanvasDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, migrateLegacy ? 'readwrite' : 'readonly')
        const store = transaction.objectStore(STORE)
        let result: unknown
        const req = store.get(key)
        req.onsuccess = () => {
          result = req.result
          if (!migrateLegacy) return
          const claim = store.get('legacy-owner')
          claim.onsuccess = () => {
            if (claim.result !== undefined) return
            // 首次升级时的当前会话认领一次；备份不删，其它会话/账号不能重复认领。
            const legacy = store.get(SCENE_KEY)
            legacy.onsuccess = () => {
              if (result === undefined && legacy.result?.version === SCENE_FORMAT) {
                result = legacy.result
                store.put(result, key)
              }
              store.put(key, 'legacy-owner')
            }
          }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      }),
  )
}

function dbPut(scene: PersistedScene, key: string, removeKey?: string): Promise<void> {
  return openCanvasDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).put(scene, key)
        if (removeKey && removeKey !== key) transaction.objectStore(STORE).delete(removeKey)
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      }),
  )
}

/**
 * 把当前场景写入 IndexedDB。files 只保留仍被 image 元素引用的（删图后不积累孤儿大文件）。
 * 返回事务是否提交成功，由界面提供重试入口。
 */
export async function saveScene(
  editor: CanvasEditor,
  key = SCENE_KEY,
  removeKey?: string,
): Promise<boolean> {
  try {
    const { elements, files, camera } = editor.doc
    const kept: Record<string, string> = {}
    for (const el of elements) {
      if (el.type === 'image' && files[el.fileId]) kept[el.fileId] = files[el.fileId]
    }
    await dbPut(
      {
        version: SCENE_FORMAT,
        elements: [...elements],
        files: kept,
        camera: { ...camera },
      },
      key,
      removeKey,
    )
    return true
  } catch (err) {
    console.warn('[canvas] 场景持久化失败', err)
    return false
  }
}

/** 读取失败必须阻止编辑与保存，不能把暂时读不到的存档当成空场景覆盖。 */
export async function loadScene(
  editor: CanvasEditor,
  key = SCENE_KEY,
  migrateLegacy = false,
): Promise<boolean> {
  const stored = (await dbGet(key, migrateLegacy)) as Partial<PersistedScene> | undefined
  if (stored === undefined) return false
  if (stored.version !== SCENE_FORMAT || !Array.isArray(stored.elements)) {
    throw new Error('Unsupported canvas scene')
  }
  editor.doc.restore(stored.elements, stored.files ?? {}, stored.camera)
  return true
}
