import type { Camera, CanvasEl } from './canvasDoc'
import type { CanvasEditor } from './editor'

/**
 * 画布场景的 IndexedDB 持久化。与项目 image-playground 主库隔离，独立 DB；
 * 单 key 存整个场景快照（自建文档模型，version 字段防旧格式串档）。
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

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function dbGet(): Promise<unknown> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(SCENE_KEY)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

function dbPut(scene: PersistedScene): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(scene, SCENE_KEY)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      }),
  )
}

/**
 * 把当前场景写入 IndexedDB。files 只保留仍被 image 元素引用的（删图后不积累孤儿大文件）。
 * best-effort：失败只告警，不打断画布操作。
 */
export async function saveScene(editor: CanvasEditor): Promise<void> {
  try {
    const { elements, files, camera } = editor.doc
    const kept: Record<string, string> = {}
    for (const el of elements) {
      if (el.type === 'image' && files[el.fileId]) kept[el.fileId] = files[el.fileId]
    }
    await dbPut({
      version: SCENE_FORMAT,
      elements: [...elements],
      files: kept,
      camera: { ...camera },
    })
  } catch (err) {
    console.warn('[canvas] 场景持久化失败', err)
  }
}

/**
 * 从 IndexedDB 恢复场景。无存档 / 格式不匹配（含旧画布库遗留数据）/ 读取失败 → 保持空画布。
 */
export async function loadScene(editor: CanvasEditor): Promise<boolean> {
  try {
    const stored = (await dbGet()) as Partial<PersistedScene> | undefined
    if (!stored || stored.version !== SCENE_FORMAT || !Array.isArray(stored.elements)) return false
    if (stored.elements.length === 0) return false
    editor.doc.restore(stored.elements, stored.files ?? {}, stored.camera)
    return true
  } catch (err) {
    console.warn('[canvas] 场景恢复失败', err)
    return false
  }
}
