// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { Box } from '../../../../features/canvas/lib/geometry'
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
      meta({ editSourceId: imageId, editKind: 'inpaint' }),
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
    // 溯源跟着新位图走：prompt 与 taskId 指的是造出这张图的那次任务。
    expect(after?.type === 'image' && after.meta?.prompt).toBe('换成绿色')
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

/**
 * 一条任务只预留了一个占位框、上游却给回多张（模型原生 n / 计费渠道整批预留一条任务）：
 * 多出来的那几张得自己找空位。按框宽硬排会直接盖住旁边的图、或另一批任务的占位框——
 * 用户画布上已经有的东西被压掉，正是这条用例要拦住的。
 */
describe('一个占位框收多张结果', () => {
  it('多出来的结果避开已有元素与别的任务占的位，彼此也不重叠', async () => {
    const doc = new CanvasDoc()
    const editor = new CanvasEditor(doc)
    doc.setViewport(4000, 3000)
    // 紧挨着占位框右侧：按框宽硬排时第二张正好压上来。
    editor.placeImages([
      { dataUrl: 'data:image/png;base64,neighbour', x: 1000, y: 0, width: 400, height: 300 },
    ])
    // 另一批任务已经占下的位：不是这条任务的，同样不能压。
    editor.createPlaceholder({ x: 1500, y: 0, w: 400, h: 300 }, meta())
    const reserved = { x: 500, y: 0, w: 400, h: 300 }
    const placeholderId = editor.createPlaceholder(reserved, meta())

    await settleGeneration(editor, placeholderId, reserved, {
      images: [RESULT, `${RESULT}-2`, `${RESULT}-3`],
    } as never)

    // 落完这条任务的占位框已被收掉：剩下邻居图 + 别人的占位框 + 三张结果。
    const boxes = editor.getOccupiedBounds()
    expect(boxes).toHaveLength(5)
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) expect(box.collides(other)).toBe(false)
    }
    // 第一张精确落回用户看着转圈的那个框，其余的才另找位置。
    const images = doc.elements.filter((el): el is ImageEl => el.type === 'image')
    expect(images.find((el) => doc.files[el.fileId] === RESULT)).toMatchObject({ x: 500, y: 0 })
  })
})
