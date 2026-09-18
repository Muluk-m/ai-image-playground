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

  it('产物记下这次调用的完整提示词，视频重新生成据此预填', async () => {
    await sink.place([
      {
        artifactId: 'agent_video_3',
        dataUrl: 'data:image/png;base64,UE9T',
        prompt: '黄昏的海边，一个人慢跑，镜头缓慢推近',
        name: '视频：海边慢跑 1',
        video: { taskId: 'task-4', outputIndex: 0 },
      },
    ])
    expect(editor.getElement('agent_video_3')).toMatchObject({
      meta: { prompt: '视频：海边慢跑', userPrompt: '黄昏的海边，一个人慢跑，镜头缓慢推近' },
    })
  })

  it('超长提示词不记，免得云端项目整份同步失败', async () => {
    await sink.place([
      {
        artifactId: 'agent_video_5',
        dataUrl: 'data:image/png;base64,UE9T',
        prompt: '长'.repeat(10001),
        name: '视频 1',
        video: { taskId: 'task-5', outputIndex: 0 },
      },
    ])
    expect(editor.getElement('agent_video_5')).not.toHaveProperty('meta.userPrompt')
  })

  it('视频产物带着生成参数落画布，「改参数重来」才有据可依', async () => {
    const generation = {
      model: 'grok-imagine-video',
      duration: 6,
      aspectRatio: '9:16',
      resolution: '720p',
      firstFrameId: 'agent_image_1',
    } as const
    await sink.place([
      {
        artifactId: 'agent_video_2',
        dataUrl: 'data:image/png;base64,UE9T',
        video: { taskId: 'task-3', outputIndex: 0, generation },
      },
    ])

    expect(editor.getElement('agent_video_2')).toMatchObject({
      video: { taskId: 'task-3', outputIndex: 0, generation },
    })
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

  it('占位不算用户编辑：占位框不进 undo 栈', async () => {
    const ids = await sink.reserve({ count: 2 })
    sink.discard(ids)

    expect(doc.canUndo).toBe(false)
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

  it('带错误码的失败占位把码记在占位框上，刷新恢复后仍在', async () => {
    const [id] = await sink.reserve({ count: 1, messageId: 'tool-credits' })

    sink.markFailed([id!], '积分不够', 'insufficient_credits')

    expect(editor.getPlaceholder(id!)).toMatchObject({
      status: 'error',
      meta: { agent: true, agentErrorCode: 'insufficient_credits' },
    })
    const restored = new CanvasDoc()
    restored.restore([...doc.elements], doc.files)
    expect(new CanvasEditor(restored).getPlaceholder(id!)?.meta.agentErrorCode).toBe(
      'insufficient_credits',
    )
  })

  it('云端项目的工具失败时立即拉取云端，服务端留下的失败占位马上出现', async () => {
    const refresh = vi.fn(() => Promise.resolve())
    const cloudSink = createAgentCanvasSink(editor, undefined, { enabled: () => true, refresh })
    // 云端项目的图片占位由服务端预留，本机不占位。
    const ids = await cloudSink.reserve({ count: 1, messageId: 'tool-cloud' })
    expect(editor.getPlaceholders()).toEqual([])

    cloudSink.markFailed(ids, '上游超时', 'timeout')

    expect(refresh).toHaveBeenCalledTimes(1)
    // 已受理的任务失败由服务端留失败占位，本机不再叠一个。
    expect(editor.getPlaceholders()).toEqual([])
  })

  it.each([
    'insufficient_credits',
    'authentication_required',
    'model_unavailable',
  ] as const)('云端项目的调用提交就被拒（%s）：本机补一个带码的失败占位，与本机项目一致', async (code) => {
    const cloudSink = createAgentCanvasSink(editor, undefined, {
      enabled: () => true,
      refresh: () => Promise.resolve(),
    })
    const ids = await cloudSink.reserve({
      count: 2,
      messageId: 'tool-refused',
      conversationId: 'conv-1',
      title: '一只橘猫',
    })

    cloudSink.markFailed(ids, '服务端写的那句话', code)

    const placeholders = editor.getPlaceholders()
    expect(placeholders).toHaveLength(2)
    for (const one of placeholders)
      expect(one).toMatchObject({
        status: 'error',
        meta: {
          agent: true,
          agentErrorCode: code,
          agentConversationId: 'conv-1',
          agentMessageId: 'tool-refused',
          prompt: '一只橘猫',
        },
      })
  })

  it('云端项目重放同一次被拒的调用不叠第二组失败占位', async () => {
    const cloud = { enabled: () => true, refresh: () => Promise.resolve() }
    const first = createAgentCanvasSink(editor, undefined, cloud)
    first.markFailed(
      await first.reserve({ count: 1, messageId: 'tool-refused' }),
      '',
      'insufficient_credits',
    )
    const replay = createAgentCanvasSink(editor, undefined, cloud)
    replay.markFailed(
      await replay.reserve({ count: 1, messageId: 'tool-refused' }),
      '',
      'insufficient_credits',
    )

    expect(editor.getPlaceholders()).toHaveLength(1)
  })

  it('云端项目的调用被收掉（成功交付、轮中止）后再失败也不补占位', async () => {
    const cloudSink = createAgentCanvasSink(editor, undefined, {
      enabled: () => true,
      refresh: () => Promise.resolve(),
    })
    const ids = await cloudSink.reserve({ count: 1, messageId: 'tool-discarded' })

    cloudSink.discard(ids)
    cloudSink.markFailed(ids, '', 'insufficient_credits')

    expect(editor.getPlaceholders()).toEqual([])
  })

  it('本机项目的工具失败不去拉取云端', async () => {
    const refresh = vi.fn(() => Promise.resolve())
    const localSink = createAgentCanvasSink(editor, undefined, { enabled: () => false, refresh })
    const [id] = await localSink.reserve({ count: 1 })

    localSink.markFailed([id!], '上游超时', 'timeout')

    expect(refresh).not.toHaveBeenCalled()
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

describe('focusPending', () => {
  it('selects the placeholders a still-running call reserved and leaves others alone', async () => {
    const mine = await sink.reserve({ count: 2, messageId: 'tool-1', title: '橘猫' })
    await sink.reserve({ count: 1, messageId: 'tool-2', title: '别的' })
    editor.setSelectedElements([])

    sink.focusPending!({ messageId: 'tool-1', taskId: 'task-1' })
    expect(editor.getSelectedIds().sort()).toEqual([...mine].sort())

    // 没有对应的占位（已经落图、或切过画布）就什么也不动。
    editor.setSelectedElements([])
    sink.focusPending!({ messageId: 'gone' })
    expect(editor.getSelectedIds()).toEqual([])
  })
})
