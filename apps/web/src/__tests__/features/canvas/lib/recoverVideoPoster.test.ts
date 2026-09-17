import { expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { recoverVideoPoster } from '../../../../features/canvas/lib/recoverVideoPoster'

vi.mock('../../../../features/agent/lib/videoPoster', () => ({
  isBlankVideoPoster: async (value: string) => value === 'blank',
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  videoOutputFrame: async () => 'real-frame',
}))
it('repairs only the legacy blank file and preserves geometry and real covers', async () => {
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  editor.placeImages([
    {
      id: 'video',
      dataUrl: 'blank',
      x: 17,
      y: 23,
      width: 320,
      height: 180,
      video: { taskId: 'task', outputIndex: 0 },
    },
  ])
  const original = doc.getElement('video')!
  await recoverVideoPoster(editor, 'video')
  const updated = doc.getElement('video')!
  expect(updated).toMatchObject({ id: 'video', x: 17, y: 23, width: 320, height: 180 })
  if (updated.type !== 'image' || original.type !== 'image') throw new Error('Expected image')
  expect(updated.fileId).not.toBe(original.fileId)
  expect(doc.files[updated.fileId]).toBe('real-frame')
  await recoverVideoPoster(editor, 'video')
  expect(doc.getElement('video')).toBe(updated)
  doc.replaceVideoPoster('video', original.fileId, 'stale-result')
  expect(doc.getElement('video')).toBe(updated)
})
