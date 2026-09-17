import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const IMAGES = [{ artifactId: 'agent_image_1', dataUrl: 'data:image/png;base64,AQID' }]

let doc: CanvasDoc
let editor: CanvasEditor
let sink: ReturnType<typeof createAgentCanvasSink>
let holdSizing = false
const sizing: (() => void)[] = []

function addText(id: string): void {
  doc.addElements([
    {
      id,
      type: 'text',
      x: 0,
      y: 0,
      text: '标注',
      fontSize: 12,
      fill: '#fff',
      width: 10,
      height: 8,
    },
  ])
}

beforeEach(() => {
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  sink = createAgentCanvasSink(editor)
  holdSizing = false
  sizing.length = 0
  // 相机动画走 rAF；node 环境里没有它，这里只需要它不抛。
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 64
      naturalHeight = 64
      onload: (() => void) | null = null
      set src(_value: string) {
        const loaded = () => this.onload?.()
        if (holdSizing) sizing.push(loaded)
        else queueMicrotask(loaded)
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

/** 修订号不再是交付的判据，仍是 undo 历史「一次用户操作」的边界，直接对 editor 断言。 */
describe('画布编辑修订号', () => {
  it('平移、缩放、选区与工具不算编辑', () => {
    addText('text-1')
    const before = editor.editRevision()

    doc.setCamera({ x: 120, y: 40 })
    doc.zoomAt(10, 10, 2)
    doc.setSelection(['text-1'])
    doc.setTool('pen')
    doc.notifyAssetLoaded()

    expect(editor.editRevision()).toBe(before)
  })

  it('增删元素与撤销重做各抬一次', () => {
    const start = editor.editRevision()

    addText('text-1')
    doc.deleteElements(['text-1'])
    doc.undo()
    doc.redo()

    expect(editor.editRevision()).toBe(start + 4)
  })

  it('一次拖拽只算一次，过程中的高频更新不重复计', () => {
    addText('text-1')
    const before = editor.editRevision()

    doc.captureHistory()
    doc.updateElements([{ id: 'text-1', patch: { x: 10 } }])
    doc.updateElements([{ id: 'text-1', patch: { x: 20 } }])

    expect(editor.editRevision()).toBe(before + 1)
  })

  it('占位框状态流转与场景恢复不算用户编辑', () => {
    const placeholderId = editor.createPlaceholder(
      { x: 0, y: 0, w: 10, h: 10 },
      { taskId: 't', clientRequestId: 'c', source: 'builtin-edge', prompt: '' },
    )
    const before = editor.editRevision()

    editor.updatePlaceholder(placeholderId, { status: 'error', message: '上游拒绝' })
    doc.restore([], {})

    expect(editor.editRevision()).toBe(before)
  })
})

describe('落画布', () => {
  it('用户中途改过画布也照样写入', async () => {
    addText('text-1')

    const outcome = await sink.place(IMAGES)

    expect(outcome).toBe('placed')
    expect(editor.getElement('agent_image_1')).toMatchObject({ type: 'image' })
  })

  it('连着两次交付都写入', async () => {
    await sink.place(IMAGES)

    const second = [{ ...IMAGES[0]!, artifactId: 'agent_image_2' }]
    expect(await sink.place(second)).toBe('placed')
    expect(editor.getElements().map((element) => element.id)).toEqual([
      'agent_image_1',
      'agent_image_2',
    ])
  })

  it('视频产物把播放来源写在它自己那一项上', async () => {
    await sink.place([
      IMAGES[0]!,
      {
        artifactId: 'agent_video_1',
        dataUrl: 'data:image/png;base64,UE9T',
        video: { taskId: 'task-2', outputIndex: 0 },
      },
    ])

    expect(editor.getElement('agent_video_1')).toMatchObject({
      type: 'image',
      video: { taskId: 'task-2', outputIndex: 0 },
    })
    expect(editor.getElement('agent_image_1')).not.toHaveProperty('video')
  })

  it('尺寸加载期间原画布失效，不再写入离开的画布', async () => {
    holdSizing = true
    let current = true
    const placing = sink.place(IMAGES, { isCurrent: () => current })
    await vi.waitFor(() => expect(sizing).toHaveLength(1))
    current = false
    sizing[0]!()

    expect(await placing).toBe('unavailable')
    expect(editor.getElement('agent_image_1')).toBeUndefined()
  })

  it('先恢复场景再交付，已恢复的产物不重复插入', async () => {
    let restore!: () => void
    const ready = new Promise<void>((resolve) => {
      restore = resolve
    })
    sink = createAgentCanvasSink(editor, ready)
    const placing = sink.place(IMAGES)
    await Promise.resolve()
    expect(editor.getElement('agent_image_1')).toBeUndefined()
    editor.placeImages([
      { id: 'agent_image_1', dataUrl: IMAGES[0]!.dataUrl, x: 10, y: 20, width: 30, height: 40 },
    ])
    restore()

    expect(await placing).toBe('placed')
    expect(editor.getElements().map((element) => element.id)).toEqual(['agent_image_1'])
    expect(editor.getElement('agent_image_1')).toMatchObject({ x: 10, y: 20 })
  })
})

describe('工具起跑占位', () => {
  /** 画布上的一张图，用来把理想位置占掉。 */
  function addImage(id: string, box: { x: number; y: number; w: number; h: number }): void {
    doc.addElements([
      {
        id,
        type: 'image',
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        rotation: 0,
        fileId: `${id}-file`,
      },
    ])
  }

  it('按数量建互不重叠的占位框，并把镜头带过去', async () => {
    const scrolled: string[][] = []
    editor.scrollToElements = (ids) => scrolled.push([...ids])

    const ids = await sink.reserve({ count: 3 })

    expect(ids).toHaveLength(3)
    const boxes = ids.map((id) => editor.getElementPageBounds(id)!)
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1)
        expect(boxes[i]!.collides(boxes[j]!)).toBe(false)
    }
    expect(scrolled).toEqual([[...ids]])
  })

  it('占位不算用户编辑：修订号不动，占位框也不进 undo 栈', async () => {
    const before = editor.editRevision()

    const ids = await sink.reserve({ count: 2 })
    sink.discard(ids)

    expect(editor.editRevision()).toBe(before)
  })

  it('占位框让开画布上已有的元素', async () => {
    // 视口中心正被一张图压着。
    const viewport = editor.getViewportPageBounds()
    addImage('existing', { x: viewport.midX - 400, y: viewport.midY - 400, w: 800, h: 800 })

    const [id] = await sink.reserve({ count: 1 })

    expect(
      editor.getElementPageBounds(id!)!.collides(editor.getElementPageBounds('existing')!),
    ).toBe(false)
  })

  it('产物落进起跑时占的那个框，随后框消失', async () => {
    const [id] = await sink.reserve({ count: 1 })
    const reserved = editor.getPlaceholder(id!)!

    const outcome = await sink.place(IMAGES, { placeholderIds: [id!] })

    expect(outcome).toBe('placed')
    expect(editor.getPlaceholder(id!)).toBeUndefined()
    const placed = editor.getElementPageBounds('agent_image_1')!
    expect(placed.midX).toBeCloseTo(reserved.x + reserved.w / 2)
    expect(placed.midY).toBeCloseTo(reserved.y + reserved.h / 2)
  })

  it('占位框比产物少时，多出来的现找空位，产物不丢', async () => {
    const [id] = await sink.reserve({ count: 1 })

    const outcome = await sink.place(
      [IMAGES[0]!, { artifactId: 'agent_image_2', dataUrl: IMAGES[0]!.dataUrl }],
      { placeholderIds: [id!] },
    )

    expect(outcome).toBe('placed')
    const first = editor.getElementPageBounds('agent_image_1')!
    const second = editor.getElementPageBounds('agent_image_2')!
    expect(first.collides(second)).toBe(false)
  })

  it('原画布已离开、没落成图时占位框留在原地，不把它连同产物一起吞掉', async () => {
    const [id] = await sink.reserve({ count: 1 })

    expect(await sink.place(IMAGES, { placeholderIds: [id!], isCurrent: () => false })).toBe(
      'unavailable',
    )
    expect(editor.getPlaceholder(id!)).toBeDefined()
  })

  it('工具失败时占位框转错误态，带上原因', async () => {
    const [id] = await sink.reserve({ count: 1 })

    sink.markFailed([id!], '上游拒绝了这张图')

    expect(editor.getPlaceholder(id!)).toMatchObject({
      status: 'error',
      message: '上游拒绝了这张图',
    })
  })
})

it('重放已失败工具时复用原占位，刷新恢复后仍然幂等', async () => {
  const ids = await sink.reserve({ count: 2, messageId: 'tool-failed', title: '失败任务' })
  sink.markFailed(ids, '上游失败')
  const restored = new CanvasDoc()
  restored.restore([...doc.elements], doc.files)
  const resumed = createAgentCanvasSink(new CanvasEditor(restored))
  const replay = await resumed.reserve({ count: 2, messageId: 'tool-failed', title: '失败任务' })
  resumed.markFailed(replay, '上游失败')
  expect(replay).toEqual(ids)
  expect(restored.elements).toHaveLength(2)
  expect(
    restored.elements.every((one) => one.type === 'placeholder' && one.status === 'error'),
  ).toBe(true)
})
