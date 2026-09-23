import { vi } from 'vitest'
import { CanvasDoc } from '../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../features/canvas/lib/editor'
import { SceneRecord } from '../../features/canvas/lib/sceneRecord'

/** 盘上没人用过的一把存档键。 */
export function freshSceneKey(): string {
  return `scene-record:${crypto.randomUUID()}`
}

/** 打开一个项目的画布存档：盘上那份读进来、恢复进文档，之后落盘也归它。 */
export async function openSceneRecord(
  key: string,
  { editor = new CanvasEditor(new CanvasDoc()), migrateLegacy = false } = {},
): Promise<SceneRecord> {
  const record = new SceneRecord(editor, key, migrateLegacy)
  await record.open()
  return record
}

/** 把这份相机位置落成盘上那条记录：需要「盘上先有一份画布」的用例用它起手。 */
export async function saveSceneRecord(key: string, camera = 0): Promise<void> {
  const record = await openSceneRecord(key)
  record.editor.doc.setCamera({ x: camera })
  await record.persist()
}

/**
 * 让下一次 IndexedDB 写入的事务中止：走落盘失败那条路的用例用它。
 * 返回的 spy 由用例自己 `mockRestore()` 放回去。
 */
export function abortNextPut() {
  const put = IDBObjectStore.prototype.put
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const request = put.apply(this, args)
    this.transaction.abort()
    return request
  })
}
