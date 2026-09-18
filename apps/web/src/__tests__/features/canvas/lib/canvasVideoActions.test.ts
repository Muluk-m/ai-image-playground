// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT, type VideoGenerationRecord } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const GROK = 'grok-imagine-video'
const SEEDANCE = 'doubao-seedance-2-0-mini-260615'

const mocks = vi.hoisted(() => ({
  submitVideoRequest: vi.fn(async () => 'req-derived'),
  awaitQueueOutputs: vi.fn(async () => [{ index: 0, width: 1280, height: 720 }]),
  showToast: vi.fn(),
  options: { current: [] as unknown[] },
  draft: {
    setModel: vi.fn(),
    setDuration: vi.fn(),
    setAspectRatio: vi.fn(),
    setResolution: vi.fn(),
  },
}))

vi.mock('../../../../lib/channels/queueClient', () => ({
  submitVideoRequest: mocks.submitVideoRequest,
  awaitQueueOutputs: mocks.awaitQueueOutputs,
  queueOutputUrl: (id: string, index: number) => `https://bff.test/${id}/${index}`,
}))
vi.mock('../../../../lib/channels/channelStore', () => ({
  getStoredChannel: (id: string) => ({ id, kind: 'openai-queue' }),
  getStoredChannels: () => [],
}))
vi.mock('../../../../lib/channels/videoChannels', () => ({
  videoModelOptions: () => mocks.options.current,
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: () => ({ blocked: false }),
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: vi.fn(),
}))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ showToast: mocks.showToast, settings: {} }) },
  storeImageFromUrl: vi.fn(),
}))
vi.mock('../../../../features/video/store', () => ({
  useVideoStore: { getState: () => mocks.draft },
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  videoOutputFrame: async () => 'data:image/png;base64,UE9TVEVS',
}))

const actions = await import('../../../../features/canvas/lib/canvasVideoActions')
const { useCanvasComposer } = await import('../../../../features/canvas/composerStore')

let doc: CanvasDoc
let editor: CanvasEditor

const GENERATED = {
  model: SEEDANCE,
  duration: 8,
  aspectRatio: '9:16',
  resolution: '1080p',
} as const

function addVideo(id: string, generation?: VideoGenerationRecord, prompt = '海边奔跑') {
  doc.addElements([
    {
      id,
      type: 'image',
      x: 0,
      y: 0,
      width: 180,
      height: 320,
      rotation: 0,
      fileId: `file-${id}`,
      meta: { prompt },
      video: { taskId: `task-${id}`, outputIndex: 0, ...(generation ? { generation } : {}) },
    },
  ])
}

function addImage(id: string, x: number) {
  doc.addElements([
    { id, type: 'image', x, y: 400, width: 100, height: 100, rotation: 0, fileId: `file-${id}` },
  ])
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.options.current = [
    { channelId: 'grok', modelId: GROK, label: 'Grok', support: VIDEO_MODEL_SUPPORT[GROK] },
    {
      channelId: 'ark',
      modelId: SEEDANCE,
      label: 'Seedance',
      support: VIDEO_MODEL_SUPPORT[SEEDANCE],
    },
  ]
  for (const fn of [mocks.submitVideoRequest, mocks.showToast, ...Object.values(mocks.draft)])
    fn.mockClear()
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  useCanvasComposer.setState({ mode: 'image', prompt: '' })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 128
      naturalHeight = 72
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('视频节点的续写 / 改视频', () => {
  it('extends with the model that can, from the recorded length', () => {
    addVideo('clip', GENERATED)
    const node = actions.canvasVideoNode(editor, 'clip')!
    const check = actions.canvasDeriveCheck(node, 'extend')
    expect(check.ok && check.option.modelId).toBe(GROK)
    expect(check.ok && check.sourceSeconds).toBe(8)
  })

  it('refuses when the length was never recorded rather than guessing', () => {
    addVideo('old')
    const check = actions.canvasDeriveCheck(actions.canvasVideoNode(editor, 'old')!, 'extend')
    expect(check.ok).toBe(false)
  })

  it('refuses an edit on a clip longer than the upstream accepts', () => {
    addVideo('long', { ...GENERATED, duration: 10 })
    const check = actions.canvasDeriveCheck(actions.canvasVideoNode(editor, 'long')!, 'edit')
    expect(check.ok).toBe(false)
  })

  it('refuses when no model in this deployment can do it', () => {
    mocks.options.current = mocks.options.current.filter(
      (one) => (one as { modelId: string }).modelId !== GROK,
    )
    addVideo('clip', GENERATED)
    const check = actions.canvasDeriveCheck(actions.canvasVideoNode(editor, 'clip')!, 'extend')
    expect(check.ok).toBe(false)
  })

  it('submits against the source clip and lands the result beside it with its lineage', async () => {
    addVideo('clip', GENERATED)
    const node = actions.canvasVideoNode(editor, 'clip')!

    const accepted = await actions.submitCanvasDerive(editor, node, {
      mode: 'extend',
      prompt: ' 继续跑向海里 ',
      seconds: 5,
    })
    await settle()

    expect(accepted).toBe(true)
    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: GROK,
        prompt: '继续跑向海里',
        inputImageDataUrls: [],
        video: expect.objectContaining({
          mode: 'extend',
          source_task_id: 'task-clip',
          source_output_index: 0,
          duration_seconds: 5,
        }),
      }),
    )
    const derived = editor
      .getElements()
      .find((el) => el.type === 'image' && el.video?.taskId === 'req-derived')
    expect(derived).toMatchObject({
      video: { generation: { derivedFrom: { id: 'clip', mode: 'extend' }, duration: 5 } },
    })
    expect(derived && 'x' in derived && derived.x).toBeGreaterThan(180)
  })
})

describe('重新生成', () => {
  it('loads the recorded settings, prompt and frames back into the generate bar', () => {
    addImage('first', 0)
    addImage('last', 300)
    addVideo('clip', { ...GENERATED, firstFrameId: 'first', lastFrameId: 'last' })

    actions.loadCanvasVideoIntoComposer(editor, actions.canvasVideoNode(editor, 'clip')!)

    expect(useCanvasComposer.getState()).toMatchObject({ mode: 'video', prompt: '海边奔跑' })
    expect(mocks.draft.setModel).toHaveBeenCalledWith(SEEDANCE)
    expect(mocks.draft.setResolution).toHaveBeenCalledWith('1080p')
    expect(mocks.draft.setDuration).toHaveBeenCalledWith(8)
    expect(mocks.draft.setAspectRatio).toHaveBeenCalledWith('9:16')
    expect(editor.getSelectedIds()).toEqual(['first', 'last'])
  })

  it('says so when the original frames are gone', () => {
    addVideo('clip', { ...GENERATED, firstFrameId: 'deleted' })
    actions.loadCanvasVideoIntoComposer(editor, actions.canvasVideoNode(editor, 'clip')!)
    expect(editor.getSelectedIds()).toEqual([])
    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), 'info')
  })

  it('brings back only the prompt for a video without a record', () => {
    addVideo('old')
    actions.loadCanvasVideoIntoComposer(editor, actions.canvasVideoNode(editor, 'old')!)
    expect(useCanvasComposer.getState()).toMatchObject({ mode: 'video', prompt: '海边奔跑' })
    expect(mocks.draft.setModel).not.toHaveBeenCalled()
  })
})

describe('截帧', () => {
  it('reports a failed capture instead of placing a blank image', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      if (this.getAttribute('src')) queueMicrotask(() => this.dispatchEvent(new Event('error')))
    })
    addVideo('clip', GENERATED)

    const placed = await actions.placeCanvasVideoFrame(
      editor,
      actions.canvasVideoNode(editor, 'clip')!,
      'last',
    )

    expect(placed).toBe(false)
    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(editor.getElements()).toHaveLength(1)
  })
})
