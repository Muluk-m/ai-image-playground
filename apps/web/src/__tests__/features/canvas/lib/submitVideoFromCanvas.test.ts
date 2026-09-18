import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const MODEL = 'doubao-seedance-2-0-mini-260615'
const support = VIDEO_MODEL_SUPPORT[MODEL]!

const mocks = vi.hoisted(() => ({
  submitVideoRequest: vi.fn(async () => 'req-1'),
  awaitQueueOutputs: vi.fn(async () => [{ index: 0, width: 720, height: 1280 }]),
  guard: vi.fn(() => ({ blocked: false })),
  settled: vi.fn(),
  showToast: vi.fn(),
  support: { current: null as unknown },
}))

vi.mock('../../../../lib/channels/queueClient', () => ({
  submitVideoRequest: mocks.submitVideoRequest,
  awaitQueueOutputs: mocks.awaitQueueOutputs,
  queueOutputUrl: (id: string, index: number) => `https://bff.test/${id}/${index}`,
}))
vi.mock('../../../../lib/channels/channelStore', () => ({
  getStoredChannel: (id: string) =>
    id === 'video-channel' ? { id, kind: 'openai-queue' } : undefined,
  getStoredChannels: () => [],
}))
vi.mock('../../../../lib/channels/videoChannels', () => ({
  videoModelOptions: () => [
    {
      channelId: 'video-channel',
      modelId: MODEL,
      label: 'Seedance 2.0',
      support: mocks.support.current,
    },
  ],
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: mocks.guard,
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: mocks.settled,
}))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ showToast: mocks.showToast, settings: {} }) },
}))
vi.mock('../../../../features/video/store', () => ({
  useVideoStore: {
    getState: () => ({
      draft: { model: MODEL, duration: 8, aspectRatio: '9:16', resolution: '720p' },
    }),
  },
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  videoOutputFrame: async () => 'data:image/png;base64,UE9TVEVS',
}))

const { retryCanvasVideo, submitReferenceVideo, submitVideoFromCanvas } = await import(
  '../../../../features/canvas/lib/submitVideoFromCanvas'
)
const { recoverCanvasTasks } = await import('../../../../features/canvas/lib/recoverCanvasTasks')
const { defaultInputItems, moveInputItem, setInputRole } = await import(
  '../../../../features/canvas/lib/videoInputs'
)

let doc: CanvasDoc
let editor: CanvasEditor

function addImage(id: string, x: number, video = false): void {
  doc.addElements([
    {
      id,
      type: 'image',
      x,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      fileId: `file-${id}`,
      ...(video ? { video: { taskId: 't-old', outputIndex: 0 } } : {}),
    },
  ])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.support.current = support
  mocks.submitVideoRequest.mockClear()
  mocks.awaitQueueOutputs.mockClear()
  mocks.showToast.mockClear()
  mocks.settled.mockClear()
  mocks.guard.mockClear()
  mocks.guard.mockImplementation(() => ({ blocked: false }))
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  vi.spyOn(editor, 'toImage').mockImplementation(async (ids) => `data:image/png;base64,${ids[0]}`)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 72
      naturalHeight = 128
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

function placedVideo() {
  return editor.getElements().find((el) => el.type === 'image' && el.video?.taskId === 'req-1')
}

describe('画布生成栏的视频档', () => {
  it('turns two selected images into first and last frame, left to right', async () => {
    addImage('right', 400)
    addImage('left', 0)
    editor.setSelectedElements(['right', 'left'])

    await submitVideoFromCanvas(editor, '  镜头推近  ')
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: MODEL,
        prompt: '镜头推近',
        inputImageDataUrls: ['data:image/png;base64,left', 'data:image/png;base64,right'],
        video: {
          duration_seconds: 8,
          aspect_ratio: '9:16',
          resolution: '720p',
          first_frame_index: 0,
          last_frame_index: 1,
        },
      }),
    )
    expect(placedVideo()).toMatchObject({
      video: {
        taskId: 'req-1',
        outputIndex: 0,
        generation: {
          model: MODEL,
          duration: 8,
          aspectRatio: '9:16',
          resolution: '720p',
          firstFrameId: 'left',
          lastFrameId: 'right',
        },
      },
    })
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it('keeps what the user typed apart from the annotation text it was merged with', async () => {
    addImage('photo', 0)
    doc.addElements([
      {
        id: 'note',
        type: 'text',
        x: 20,
        y: 20,
        text: '让她转身',
        fontSize: 24,
        fill: '#ef4444',
        width: 60,
        height: 30,
      },
    ])
    editor.setSelectedElements(['photo'])

    await submitVideoFromCanvas(editor, '慢镜头')
    await settle()

    // 重新生成只载回原话：标注还在首帧上，会随选区再拼一次。
    expect(placedVideo()).toMatchObject({
      meta: { prompt: '让她转身\n慢镜头', userPrompt: '慢镜头' },
    })
  })

  it('generates from text when nothing is selected', async () => {
    await submitVideoFromCanvas(editor, '海浪')
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ inputImageDataUrls: [] }),
    )
    const video = placedVideo()
    expect(video?.type === 'image' && video.video?.generation).toEqual({
      model: MODEL,
      duration: 8,
      aspectRatio: '9:16',
      resolution: '720p',
    })
  })

  it('refuses a last frame the model cannot take before anything is placed', async () => {
    mocks.support.current = { ...support, lastFrame: false }
    addImage('a', 0)
    addImage('b', 300)
    editor.setSelectedElements(['a', 'b'])

    await submitVideoFromCanvas(editor, '转场')

    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it('does not use a selected video as a frame', async () => {
    addImage('clip', 0, true)
    editor.setSelectedElements(['clip'])

    await submitVideoFromCanvas(editor, '续一段')

    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it('stops at the billing guard without leaving an empty placeholder', async () => {
    mocks.guard.mockImplementation(() => ({ blocked: true, disabledReason: '积分不足' }))

    await submitVideoFromCanvas(editor, '海浪')

    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL, quantity: 8 }))
    expect(mocks.showToast).toHaveBeenCalledWith('积分不足', 'error')
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it('reports whether the submission was accepted so the bar keeps a refused prompt', async () => {
    expect(await submitVideoFromCanvas(editor, '海浪')).toBe(true)
    addImage('clip', 0, true)
    editor.setSelectedElements(['clip'])
    expect(await submitVideoFromCanvas(editor, '续一段')).toBe(false)
  })

  it('keeps drawn annotations out of the frame and passes their text in the prompt', async () => {
    addImage('photo', 0)
    doc.addElements([
      {
        id: 'ring',
        type: 'freedraw',
        points: [10, 10, 90, 90],
        stroke: '#ef4444',
        strokeWidth: 12,
      },
      {
        id: 'note',
        type: 'text',
        x: 20,
        y: 20,
        text: '让她转身',
        fontSize: 24,
        fill: '#ef4444',
        width: 60,
        height: 30,
      },
    ])
    editor.setSelectedElements(['photo'])

    await submitVideoFromCanvas(editor, '慢镜头')
    await settle()

    // 首帧会原样出现在成片里：只栅格化图片本身，红圈不能跟着进去。
    expect(editor.toImage).toHaveBeenCalledWith(['photo'], expect.anything())
    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '让她转身\n慢镜头' }),
    )
  })

  it('does not select the new video, so the next clip can be generated right away', async () => {
    addImage('left', 0)
    editor.setSelectedElements(['left'])

    await submitVideoFromCanvas(editor, '走过来')
    await settle()

    expect(placedVideo()).toBeDefined()
    expect(editor.getSelectedIds()).toEqual(['left'])
  })

  it('still lands a paid video when its placeholder was deleted while generating', async () => {
    let release!: () => void
    mocks.awaitQueueOutputs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ index: 0, width: 720, height: 1280 }])
        }),
    )
    await submitVideoFromCanvas(editor, '海浪')
    await settle()
    editor.deleteElement(editor.getPlaceholders()[0]!.id)

    release()
    await settle()

    expect(placedVideo()).toBeDefined()
  })

  it('retries a failed image-to-video with the same frames in the same session', async () => {
    addImage('photo', 0)
    editor.setSelectedElements(['photo'])
    mocks.awaitQueueOutputs.mockRejectedValueOnce(new Error('上游超时'))
    await submitVideoFromCanvas(editor, '海浪')
    await settle()
    const failed = editor.getPlaceholders()[0]!
    expect(failed.status).toBe('error')
    mocks.submitVideoRequest.mockClear()

    retryCanvasVideo(editor, failed)
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ inputImageDataUrls: ['data:image/png;base64,photo'] }),
    )
    expect(placedVideo()).toBeDefined()
  })

  it('marks the placeholder failed when the queue fails', async () => {
    mocks.awaitQueueOutputs.mockRejectedValueOnce(new Error('上游超时'))

    await submitVideoFromCanvas(editor, '海浪')
    await settle()

    expect(editor.getPlaceholders()[0]).toMatchObject({ status: 'error', message: '上游超时' })
  })
})

describe('选中即参考', () => {
  const withReferences = {
    ...support,
    referenceImages: { max: 3, maxResolution: '720p', withFrames: true },
  } as const
  // 校验读的是共享矩阵本身，所以在这里临时给这个模型开参考图。
  const withMatrix = (run: () => Promise<void>) => async () => {
    VIDEO_MODEL_SUPPORT[MODEL] = withReferences
    try {
      await run()
    } finally {
      VIDEO_MODEL_SUPPORT[MODEL] = support
    }
  }

  function items(ids: string[]) {
    const byX = ids.map((id) => {
      const box = editor.getElementPageBounds(id)!
      return { imageId: id, box, graphicIds: [] }
    })
    return defaultInputItems(byX)
  }

  it(
    'sends the first frame, then the references in panel order, and records them',
    withMatrix(async () => {
      mocks.support.current = withReferences
      addImage('a', 0)
      addImage('b', 200)
      addImage('c', 400)
      // 面板：c 拖到最前，a 标成首帧 → 首帧 a，参考 c、b。
      const panel = setInputRole(moveInputItem(items(['a', 'b', 'c']), 2, 0), 1, 'first')

      expect(await submitReferenceVideo(editor, panel, '一起出场')).toBe(true)
      await settle()

      expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '一起出场',
          inputImageDataUrls: [
            'data:image/png;base64,a',
            'data:image/png;base64,c',
            'data:image/png;base64,b',
          ],
          video: {
            duration_seconds: 8,
            aspect_ratio: '9:16',
            resolution: '720p',
            first_frame_index: 0,
            reference_image_indices: [1, 2],
          },
        }),
      )
      expect(placedVideo()).toMatchObject({
        video: { generation: { firstFrameId: 'a', referenceIds: ['c', 'b'] } },
      })
      // 占位与成片落在这几张图右侧。
      expect(editor.getElementPageBounds(placedVideo()!.id)!.x).toBeGreaterThanOrEqual(500)
    }),
  )

  it('refuses references the model cannot take before anything is placed', async () => {
    addImage('a', 0)
    expect(await submitReferenceVideo(editor, items(['a']), '出场')).toBe(false)
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('参考图'), 'error')
    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it(
    'refuses references when the channel has not declared them, even if the matrix allows',
    withMatrix(async () => {
      mocks.support.current = support
      addImage('a', 0)
      addImage('b', 200)
      expect(await submitReferenceVideo(editor, items(['a', 'b']), '出场')).toBe(false)
      expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('不支持参考图'), 'error')
      expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    }),
  )

  it(
    'refuses more references than the model takes',
    withMatrix(async () => {
      mocks.support.current = withReferences
      for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) addImage(id, index * 200)
      expect(await submitReferenceVideo(editor, items(['a', 'b', 'c', 'd']), '出场')).toBe(false)
      expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('3'), 'error')
    }),
  )
})

describe('刷新之后', () => {
  const generation = { model: MODEL, duration: 8, aspectRatio: '9:16', resolution: '720p' } as const

  it('resumes a submitted canvas video from its request id without resubmitting', async () => {
    editor.createPlaceholder(
      { x: 0, y: 0, w: 360, h: 360 },
      {
        taskId: 'task-1',
        clientRequestId: 'client-1',
        source: 'builtin-edge',
        prompt: '海浪',
        bffRequestId: 'req-1',
        video: { channelId: 'video-channel', generation },
      },
    )

    recoverCanvasTasks(editor)
    await settle()

    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(mocks.awaitQueueOutputs).toHaveBeenCalledWith('req-1')
    expect(placedVideo()).toMatchObject({ video: { taskId: 'req-1', generation } })
    // 续跑出片同样通知计费面板，余额才会刷新。
    expect(mocks.settled).toHaveBeenCalled()
  })

  it("keeps a derived clip's failed placeholder when its source is gone, instead of deleting it first", () => {
    const id = editor.createPlaceholder(
      { x: 0, y: 0, w: 360, h: 360 },
      {
        taskId: 'task-3',
        clientRequestId: 'client-3',
        source: 'builtin-edge',
        prompt: '接着跑',
        video: {
          channelId: 'video-channel',
          generation: { ...generation, derivedFrom: { id: 'deleted-source', mode: 'extend' } },
        },
      },
    )
    editor.updatePlaceholder(id, { status: 'error', message: '上游超时' })

    retryCanvasVideo(editor, editor.getPlaceholder(id)!)

    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(mocks.guard).not.toHaveBeenCalled()
    expect(editor.getPlaceholder(id)).toBeDefined()
  })

  it('will not retry as text-to-video once the frames are gone', () => {
    const id = editor.createPlaceholder(
      { x: 0, y: 0, w: 360, h: 360 },
      {
        taskId: 'task-2',
        clientRequestId: 'client-2',
        source: 'builtin-edge',
        prompt: '海浪',
        inputCount: 1,
        video: { channelId: 'video-channel', generation: { ...generation, firstFrameId: 'a' } },
      },
    )

    retryCanvasVideo(editor, editor.getPlaceholder(id)!)

    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(editor.getPlaceholder(id)).toBeDefined()
  })
})
