// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { settleGeneration } from '../../../../features/canvas/lib/placeholderShapeOps'

// jsdom 不解码图片；这里只关心「落到哪个元素上」，尺寸给个定值即可。
vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: async () => ({ width: 1024, height: 768 }),
}))

const RESULT = 'data:image/png;base64,result'

function canvasWithImage() {
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  const [imageId] = editor.placeImages([
    { dataUrl: 'data:image/png;base64,source', x: 0, y: 0, width: 400, height: 300 },
  ])
  return { doc, editor, imageId: imageId! }
}

const meta = (extra: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  clientRequestId: 'req-1',
  source: 'user-byok' as const,
  prompt: '换成绿色',
  ...extra,
})

/**
 * 二次加工（局部重绘 / 擦除 / 扩图）改的就是选中那一张：结果必须换掉它的位图，
 * 而不是在旁边多出一张。退化成「放新图」时画面上会同时出现两处「处理中」，
 * 而且每改一次画布就多一份垃圾——这正是这条用例要拦住的。
 */
describe('settleGeneration', () => {
  it('replaces the edited image in place instead of adding a second one', async () => {
    const { doc, editor, imageId } = canvasWithImage()
    const before = doc.getElement(imageId)
    const placeholderId = editor.createPlaceholder(
      { x: 0, y: 0, w: 400, h: 300 },
      meta({ editSourceId: imageId, editKind: 'inpaint', regen: '{"v":1}' }),
    )

    const placed = await settleGeneration(editor, placeholderId, { x: 0, y: 0, w: 400, h: 300 }, {
      images: [RESULT],
    } as never)

    expect(placed).toBe(true)
    const after = doc.getElement(imageId)
    expect(after?.type).toBe('image')
    expect(doc.elements.filter((el) => el.type === 'image')).toHaveLength(1)
    expect(doc.getElement(placeholderId)).toBeUndefined()
    // 换的是位图本身，不是又铸了个元素。
    expect(after?.type === 'image' && after.fileId).not.toBe(
      before?.type === 'image' && before.fileId,
    )
    expect(after?.type === 'image' && doc.files[after.fileId]).toBe(RESULT)
    // 溯源跟着新位图走，否则「重新生成」会照着上一张图的配方重出。
    expect(after?.type === 'image' && after.meta?.regen).toBe('{"v":1}')
  })

  it('still places a new element when the task is a plain generation', async () => {
    const { doc, editor } = canvasWithImage()
    const placeholderId = editor.createPlaceholder({ x: 500, y: 0, w: 400, h: 300 }, meta())

    await settleGeneration(editor, placeholderId, { x: 500, y: 0, w: 400, h: 300 }, {
      images: [RESULT],
    } as never)

    expect(doc.elements.filter((el) => el.type === 'image')).toHaveLength(2)
  })

  it('keeps the placeholder as an error when the edit source is gone', async () => {
    const { doc, editor, imageId } = canvasWithImage()
    const placeholderId = editor.createPlaceholder(
      { x: 0, y: 0, w: 400, h: 300 },
      meta({ editSourceId: imageId, editKind: 'erase' }),
    )
    editor.deleteElement(imageId)

    await settleGeneration(editor, placeholderId, { x: 0, y: 0, w: 400, h: 300 }, {
      images: [RESULT],
    } as never)

    // 源图没了就退回「放新图」，结果不能丢。
    expect(doc.elements.filter((el) => el.type === 'image')).toHaveLength(1)
  })
})
