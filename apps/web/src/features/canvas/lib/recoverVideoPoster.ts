import { videoOutputFrame } from '../../agent/lib/artifactSource'
import { isBlankVideoPoster } from '../../agent/lib/videoPoster'
import type { CanvasEditor } from './editor'

export async function recoverVideoPoster(editor: CanvasEditor, id: string): Promise<void> {
  const element = editor.getElement(id)
  if (element?.type !== 'image' || !element.video) return
  const source = editor.doc.files[element.fileId]
  if (!source || !(await isBlankVideoPoster(source))) return
  const poster = await videoOutputFrame(element.video)
  if (poster) editor.doc.replaceVideoPoster(id, element.fileId, poster)
}
