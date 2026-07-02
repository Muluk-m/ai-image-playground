import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { CanvasEditor } from './editor'

/**
 * 画布场景的 IndexedDB 持久化（替代原 tldraw persistenceKey 内置持久化）。
 * 与项目 image-playground 主库隔离，独立 DB；单 key 存整个场景快照。
 */
const DB_NAME = 'image-playground-canvas'
const DB_VERSION = 1
const STORE = 'scene'
const SCENE_KEY = 'scene'

/** onChange 高频触发（指针移动也算），落盘防抖窗口。 */
export const PERSIST_DEBOUNCE_MS = 500

interface PersistedScene {
  elements: readonly ExcalidrawElement[]
  files: BinaryFiles
  appState: { scrollX: number; scrollY: number; zoomValue: number }
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

function dbGet(): Promise<PersistedScene | undefined> {
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
 * 把当前场景写入 IndexedDB。files 只保留仍被 image 元素引用的（删除图片后不积累孤儿大文件）。
 * best-effort：失败只告警，不打断画布操作。
 */
export async function saveScene(editor: CanvasEditor): Promise<void> {
  try {
    const elements = editor.getElements()
    const allFiles = editor.api.getFiles()
    const referenced = new Set(
      elements.map((el) => (el.type === 'image' ? el.fileId : null)).filter(Boolean),
    )
    const files: BinaryFiles = {}
    for (const [id, file] of Object.entries(allFiles)) {
      if (referenced.has(id as never)) files[id] = file
    }
    const s = editor.api.getAppState()
    await dbPut({
      // 结构化克隆要求纯数据；元素本就是 plain object，浅拷贝防御 readonly 数组
      elements: [...elements],
      files,
      appState: { scrollX: s.scrollX, scrollY: s.scrollY, zoomValue: s.zoom.value },
    })
  } catch (err) {
    console.warn('[canvas] 场景持久化失败', err)
  }
}

/**
 * 从 IndexedDB 恢复场景到编辑器（restore 归一化跨版本 schema 差异）。
 * 无存档 / 读取失败 → 保持空画布。返回是否恢复了内容。
 */
export async function loadScene(editor: CanvasEditor): Promise<boolean> {
  try {
    const stored = await dbGet()
    if (!stored || stored.elements.length === 0) return false
    const elements = restoreElements(stored.elements, null, { repairBindings: true })
    editor.api.addFiles(Object.values(stored.files ?? {}))
    editor.api.updateScene({
      elements,
      // 恢复视口：回到上次离开的位置
      appState: {
        scrollX: stored.appState.scrollX,
        scrollY: stored.appState.scrollY,
        zoom: { value: stored.appState.zoomValue as never },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    return true
  } catch (err) {
    console.warn('[canvas] 场景恢复失败', err)
    return false
  }
}
