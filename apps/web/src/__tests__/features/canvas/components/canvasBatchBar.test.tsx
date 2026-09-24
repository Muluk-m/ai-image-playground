// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanvasBatchBar from '../../../../features/canvas/components/CanvasBatchBar'
import { useInpaintSession } from '../../../../features/canvas/inpaintStore'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { useRectEdit } from '../../../../features/canvas/rectEditStore'

const actions = vi.hoisted(() => ({
  cutout: vi.fn(async () => true),
  resize: vi.fn(async () => true),
}))
vi.mock('../../../../features/canvas/lib/canvasImageEdits', () => ({
  cutoutRefusal: () => null,
  imageEditRefusal: () => null,
  outpaintRefusal: () => null,
  resizeRefusal: () => null,
  submitCanvasCutout: actions.cutout,
  submitCanvasResize: actions.resize,
  RESIZE_RATIOS: [{ ratio: '1:1', key: 'square' }],
}))
vi.mock('../../../../features/canvas/lib/submitInpaint', () => ({ inpaintRefusal: () => null }))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, disabledReason: null }),
}))

let root: Root
let host: HTMLDivElement
let doc: CanvasDoc
let editor: CanvasEditor

function addImage(id: string, x: number, video = false) {
  doc.addElements([
    {
      id,
      type: 'image',
      x,
      y: 0,
      width: 200,
      height: 100,
      rotation: 0,
      fileId: `file-${id}`,
      naturalWidth: 200,
      naturalHeight: 100,
      ...(video ? { video: { taskId: id, outputIndex: 0 } } : {}),
    },
  ])
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].find(
    (item) => item.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`No button: ${label}`)
  return found
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  actions.cutout.mockClear()
  actions.resize.mockClear()
  useInpaintSession.getState().close()
  useRectEdit.getState().close()
  doc = new CanvasDoc()
  editor = new CanvasEditor(doc)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('画布多图工具条', () => {
  it('用和单图相同的八个编辑动作取代批量生成，并对每张图发起抠图', async () => {
    addImage('a', 0)
    addImage('b', 300)
    doc.setSelection(['a', 'b'])
    act(() => root.render(<CanvasBatchBar editor={editor} />))

    for (const label of [
      '局部重绘',
      '擦除',
      '抠图',
      '编辑图片',
      '裁切',
      '扩图',
      '调整尺寸',
      '更多',
    ])
      expect(button(label)).toBeDefined()
    expect(host.textContent).not.toContain('批量生成')
    await act(async () => button('抠图').click())
    expect(actions.cutout).toHaveBeenCalledTimes(2)
    expect(
      actions.cutout.mock.calls.map((call) => (call as unknown as [unknown, { id: string }])[1].id),
    ).toEqual(['a', 'b'])
  })

  it('逐张打开各自的涂抹会话，关闭上一张后才轮到下一张', () => {
    addImage('a', 0)
    addImage('b', 300)
    doc.setSelection(['a', 'b'])
    act(() => root.render(<CanvasBatchBar editor={editor} />))
    act(() => button('局部重绘').click())
    expect(useInpaintSession.getState().imageId).toBe('a')
    act(() => useInpaintSession.getState().close())
    expect(useInpaintSession.getState().imageId).toBe('b')
    act(() => useInpaintSession.getState().close())
    expect(useInpaintSession.getState().imageId).toBeNull()
  })

  it('视频封面不混进批量图片操作', async () => {
    addImage('a', 0)
    addImage('video', 300, true)
    doc.setSelection(['a', 'video'])
    act(() => root.render(<CanvasBatchBar editor={editor} />))
    expect(button('抠图').getAttribute('aria-disabled')).toBe('true')
    await act(async () => button('抠图').click())
    expect(actions.cutout).not.toHaveBeenCalled()
  })
})
