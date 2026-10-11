import {
  type CanvasOrigin,
  canvasOrigin,
  createCanvasUndoManager,
  importLegacyElements,
  type LegacyCanvasElement,
} from '@image-playground/shared'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

/** 本机节点画布：一个项目一份 `Y.Doc`，存在它自己的 IndexedDB 库里，旧存档只读不写。 */
export interface NodeCanvasDocument {
  readonly doc: Y.Doc
  readonly origin: CanvasOrigin
  readonly undo: Y.UndoManager
  destroy(): void
}

const deviceOrigin = canvasOrigin('user', 'device')
const importOrigin = canvasOrigin('system', 'legacy-import')

export function nodeCanvasDatabaseName(sceneKey: string): string {
  return `image-playground-nodes:${sceneKey}`
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
    await persistence.whenSynced
  } catch (error) {
    await persistence.destroy()
    doc.destroy()
    throw error
  }
  importLegacyElements(doc, legacy(), importOrigin)
  const undo = createCanvasUndoManager(doc, deviceOrigin)
  return {
    doc,
    origin: deviceOrigin,
    undo,
    destroy() {
      undo.destroy()
      void persistence.destroy()
      doc.destroy()
    },
  }
}
