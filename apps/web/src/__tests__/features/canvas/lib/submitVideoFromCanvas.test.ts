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
  notifyPrivateSubmissionSettled: vi.fn(),
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

const { retryCanvasVideo, submitVideoFromCanvas } = await import(
  '../../../../features/canvas/lib/submitVideoFromCanvas'
)
const { recoverCanvasTasks } = await import('../../../../features/canvas/lib/recoverCanvasTasks')

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

  it('marks the placeholder failed when the queue fails', async () => {
    mocks.awaitQueueOutputs.mockRejectedValueOnce(new Error('上游超时'))

    await submitVideoFromCanvas(editor, '海浪')
    await settle()

    expect(editor.getPlaceholders()[0]).toMatchObject({ status: 'error', message: '上游超时' })
  })
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
