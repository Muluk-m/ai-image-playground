import { CanvasDoc } from '../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../features/canvas/lib/editor'
import { SceneRecord } from '../../features/canvas/lib/sceneRecord'

/** 打开一个项目的画布存档：盘上那份读进来、恢复进文档，之后落盘也归它。 */
export async function openSceneRecord(
  key: string,
  editor = new CanvasEditor(new CanvasDoc()),
): Promise<SceneRecord> {
  const record = new SceneRecord(editor, key)
  await record.open()
  return record
}

/** 把这份相机位置落成盘上那条记录：需要「盘上先有一份画布」的用例用它起手。 */
export async function saveSceneRecord(key: string, camera = 0): Promise<void> {
  const record = await openSceneRecord(key)
  record.editor.doc.setCamera({ x: camera })
  await record.persist()
}
