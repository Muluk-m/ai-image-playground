import {
  type CanvasOrigin,
  canvasOrigin,
  createCanvasUndoManager,
  importLegacyElements,
  initializeCanvasTexts,
  type LegacyCanvasElement,
} from '@image-playground/shared'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

/** 本机节点画布：一个项目一份 `Y.Doc`，存在它自己的 IndexedDB 库里，旧存档只读不写。 */
export interface NodeCanvasDocument {
  readonly doc: Y.Doc
  readonly origin: CanvasOrigin
  readonly undo: Y.UndoManager
  destroy(): Promise<void>
}

const deviceOrigin = canvasOrigin('user', 'device')
const importOrigin = canvasOrigin('system', 'legacy-import')

export function nodeCanvasDatabaseName(sceneKey: string): string {
  return `image-playground-nodes:${sceneKey}`
}

async function migratePersistedDocument(
  persistence: IndexeddbPersistence,
  doc: Y.Doc,
  legacy: () => readonly LegacyCanvasElement[],
): Promise<void> {
  // y-indexeddb 9 的 `_db` 是建库 Promise，`updates` 是自增键的 Yjs 更新日志。
  // 读完整日志、选首次迁移者和写快照共用一个 readwrite 事务，跨标签页也只有一个赢家。
  const db = await persistence._db
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('updates', 'readwrite')
    const updates = transaction.objectStore('updates')
    let failure: unknown
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(failure ?? transaction.error ?? new Error('Canvas migration aborted'))
    transaction.onerror = () => {
      failure ??= transaction.error
    }
    const request = updates.getAll()
    request.onerror = () => {
      failure = request.error
    }
    request.onsuccess = () => {
      try {
        // 外层 origin 阻止持久化监听器另开写事务；本次更新由当前事务原子提交。
        doc.transact(() => {
          for (const update of request.result) Y.applyUpdate(doc, update)
          const imported = doc.getMap('meta').get('legacyImported')
          if (!imported) importLegacyElements(doc, legacy(), importOrigin)
          if (initializeCanvasTexts(doc) || !imported) updates.add(Y.encodeStateAsUpdate(doc))
        }, persistence)
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
  })
}

/**
 * 打开一个项目的节点画布。第一次打开时把旧存档的元素搬进来；之后以这份文档为准，
 * 旧存档原样留着。
 */
export async function openNodeCanvasDocument(
  sceneKey: string,
  legacy: () => readonly LegacyCanvasElement[],
): Promise<NodeCanvasDocument> {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(nodeCanvasDatabaseName(sceneKey), doc)
  try {
    await migratePersistedDocument(persistence, doc, legacy)
  } catch (error) {
    try {
      await persistence.destroy().catch(() => {})
    } finally {
      doc.destroy()
    }
    throw error
  }
  const undo = createCanvasUndoManager(doc, deviceOrigin)
  return {
    doc,
    origin: deviceOrigin,
    undo,
    async destroy() {
      undo.destroy()
      // 关库会等未写完的更新落盘。
      await persistence.destroy()
      doc.destroy()
    },
  }
}
