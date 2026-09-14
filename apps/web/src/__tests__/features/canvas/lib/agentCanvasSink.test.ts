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

describe('画布编辑修订号', () => {
  it('平移、缩放、选区与工具不算编辑', () => {
    addText('text-1')
    const before = sink.revision()

    doc.setCamera({ x: 120, y: 40 })
    doc.zoomAt(10, 10, 2)
    doc.setSelection(['text-1'])
    doc.setTool('pen')
    doc.notifyAssetLoaded()

    expect(sink.revision()).toBe(before)
  })

  it('增删元素与撤销重做各抬一次', () => {
    const start = sink.revision()

    addText('text-1')
    doc.deleteElements(['text-1'])
    doc.undo()
    doc.redo()

    expect(sink.revision()).toBe(start + 4)
  })

  it('一次拖拽只算一次，过程中的高频更新不重复计', () => {
    addText('text-1')
    const before = sink.revision()

    doc.captureHistory()
    doc.updateElements([{ id: 'text-1', patch: { x: 10 } }])
    doc.updateElements([{ id: 'text-1', patch: { x: 20 } }])

    expect(sink.revision()).toBe(before + 1)
  })

  it('占位框状态流转与场景恢复不算用户编辑', () => {
    const placeholderId = editor.createPlaceholder(
      { x: 0, y: 0, w: 10, h: 10 },
      { taskId: 't', clientRequestId: 'c', source: 'builtin-edge', prompt: '' },
    )
    const before = sink.revision()

    editor.updatePlaceholder(placeholderId, { status: 'error', message: '上游拒绝' })
    doc.restore([], {})

    expect(sink.revision()).toBe(before)
  })
})

describe('落画布', () => {
  it('基线与当前修订号一致时写入', async () => {
    const outcome = await sink.place(IMAGES, { baseRevision: sink.revision() })

    expect(outcome).toBe('placed')
    expect(editor.getElement('agent_image_1')).toMatchObject({ type: 'image' })
  })

  it('基线过期时判为画布冲突，一张都不写', async () => {
    const base = sink.revision()
    addText('text-1')

    const outcome = await sink.place(IMAGES, { baseRevision: base })

    expect(outcome).toBe('conflict')
    expect(editor.getElement('agent_image_1')).toBeUndefined()
  })

  it('不带基线时无条件写入', async () => {
    addText('text-1')

    const outcome = await sink.place(IMAGES)

    expect(outcome).toBe('placed')
    expect(editor.getElement('agent_image_1')).toMatchObject({ type: 'image' })
  })

  it('写入后的修订号可以当作下一次的基线', async () => {
    await sink.place(IMAGES, { baseRevision: sink.revision() })

    const second = [{ ...IMAGES[0]!, artifactId: 'agent_image_2' }]
    expect(await sink.place(second, { baseRevision: sink.revision() })).toBe('placed')
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

  it('图片尺寸晚到期间用户编辑，真正插入前仍判为冲突', async () => {
    holdSizing = true
    const placing = sink.place(IMAGES, { baseRevision: sink.revision() })
    await vi.waitFor(() => expect(sizing).toHaveLength(1))
    addText('user-edit')
    sizing[0]!()

    expect(await placing).toBe('conflict')
    expect(editor.getElement('agent_image_1')).toBeUndefined()
    expect(editor.getElement('user-edit')).toMatchObject({ type: 'text' })
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
