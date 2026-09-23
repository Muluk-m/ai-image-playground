// @vitest-environment jsdom
import type { AgentCanvasEditPlan } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

function canvas() {
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  const [imageId] = editor.placeImages([
    { dataUrl: 'data:image/png;base64,x', x: 10, y: 20, width: 400, height: 300, name: '旧名字' },
  ])
  const placeholderId = editor.createPlaceholder(
    { x: 900, y: 0, w: 200, h: 200 },
    { taskId: 't', clientRequestId: 'c', source: 'user-byok', prompt: '' },
  )
  return { doc, editor, sink: createAgentCanvasSink(editor), imageId: imageId!, placeholderId }
}

const plan = (edits: AgentCanvasEditPlan['edits']): AgentCanvasEditPlan => ({ edits })

/**
 * 智能体改画布对象是**只改属性**：位图不动、不新建元素、能一步撤回。
 * 这几条错一条，用户看到的都是「它把我的画布搞乱了」。
 */
describe('agentCanvasSink.editElements', () => {
  it('renames and resizes the named image without touching the bitmap', async () => {
    const { doc, sink, imageId } = canvas()
    const before = doc.getElement(imageId)

    const outcome = await sink.editElements!(
      plan([{ elementId: imageId, name: '浴缸_3x4', width: 600, y: 80 }]),
    )

    expect(outcome).toBe('placed')
    const after = doc.getElement(imageId)
    if (after?.type !== 'image' || before?.type !== 'image') throw new Error('unreachable')
    expect(after.name).toBe('浴缸_3x4')
    expect(after.width).toBe(600)
    expect(after.y).toBe(80)
    // 没给的那几项原样不动，位图更是一个字节没换。
    expect(after.height).toBe(before.height)
    expect(after.x).toBe(before.x)
    expect(after.fileId).toBe(before.fileId)
  })

  it('is undoable, because this is a user-visible edit rather than scaffolding', async () => {
    const { doc, sink, imageId } = canvas()

    await sink.editElements!(plan([{ elementId: imageId, name: '新名字' }]))
    doc.undo()

    const after = doc.getElement(imageId)
    expect(after?.type === 'image' && after.name).toBe('旧名字')
  })

  it('refuses placeholders and unknown ids instead of half-applying', async () => {
    const { doc, sink, placeholderId } = canvas()
    const before = doc.getElement(placeholderId)

    // 生成占位由服务端登记，客户端改一个字整份保存都会被拒。
    const outcome = await sink.editElements!(
      plan([
        { elementId: placeholderId, name: '改不得' },
        { elementId: 'nope', name: '不存在' },
      ]),
    )

    expect(outcome).toBe('unavailable')
    expect(doc.getElement(placeholderId)).toEqual(before)
  })

  it('applies the images it recognises and skips the rest', async () => {
    const { doc, sink, imageId } = canvas()

    const outcome = await sink.editElements!(
      plan([
        { elementId: 'nope', name: '不存在' },
        { elementId: imageId, name: '认得这个' },
      ]),
    )

    expect(outcome).toBe('placed')
    const after = doc.getElement(imageId)
    expect(after?.type === 'image' && after.name).toBe('认得这个')
  })
})
