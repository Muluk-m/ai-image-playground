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
    draft: {} as Record<string, unknown>,
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
  isVideoModeAvailable: () => mocks.options.current.length > 0,
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

function addVideo(
  id: string,
  generation?: VideoGenerationRecord,
  meta: Record<string, string> = { prompt: '海边奔跑', userPrompt: '海边奔跑' },
) {
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
      meta,
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
  for (const fn of [
    mocks.submitVideoRequest,
    mocks.showToast,
    mocks.draft.setModel,
    mocks.draft.setDuration,
    mocks.draft.setAspectRatio,
    mocks.draft.setResolution,
  ])
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
      meta: { userPrompt: '继续跑向海里' },
      video: { generation: { derivedFrom: { id: 'clip', mode: 'extend' }, duration: 5 } },
    })
    expect(derived && 'x' in derived && derived.x).toBeGreaterThan(180)
  })
})

describe('改参数重新生成', () => {
  const DRAFT = { model: SEEDANCE, duration: 8, aspectRatio: '9:16', resolution: '1080p' }

  beforeEach(() => {
    mocks.draft.draft = { ...DRAFT }
  })

  it('loads the recorded model and presets into the video draft', () => {
    expect(actions.loadGenerationIntoDraft(GENERATED)).toBe(true)
    expect(mocks.draft.setModel).toHaveBeenCalledWith(SEEDANCE)
    expect(mocks.draft.setResolution).toHaveBeenCalledWith('1080p')
    expect(mocks.draft.setDuration).toHaveBeenCalledWith(8)
    expect(mocks.draft.setAspectRatio).toHaveBeenCalledWith('9:16')
  })

  it('leaves the draft alone when the recorded model is not available here', () => {
    mocks.options.current = mocks.options.current.filter(
      (one) => (one as { modelId: string }).modelId !== SEEDANCE,
    )
    expect(actions.loadGenerationIntoDraft(GENERATED)).toBe(false)
    expect(mocks.draft.setModel).not.toHaveBeenCalled()
  })

  it('resubmits with the edited prompt, keeps the original frames and lands beside the clip', async () => {
    addImage('first', 0)
    addImage('last', 300)
    addVideo('clip', { ...GENERATED, firstFrameId: 'first', lastFrameId: 'last' })
    vi.spyOn(editor, 'toImage').mockImplementation(async (ids) => `data:image/png;base64,${ids[0]}`)

    const accepted = await actions.regenerateCanvasVideo(
      editor,
      actions.canvasVideoNode(editor, 'clip')!,
      ' 慢一点 ',
    )
    await settle()

    expect(accepted).toBe(true)
    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: SEEDANCE,
        prompt: '慢一点',
        inputImageDataUrls: ['data:image/png;base64,first', 'data:image/png;base64,last'],
        video: expect.objectContaining({ first_frame_index: 0, last_frame_index: 1 }),
      }),
    )
    const result = editor
      .getElements()
      .find((el) => el.type === 'image' && el.video?.taskId === 'req-derived')
    expect(result).toMatchObject({
      meta: { userPrompt: '慢一点' },
      video: { generation: { firstFrameId: 'first', lastFrameId: 'last', duration: 8 } },
    })
  })

  it('generates from text only when the recorded frames are gone', async () => {
    addImage('last', 300)
    addVideo('clip', { ...GENERATED, firstFrameId: 'deleted', lastFrameId: 'last' })

    await actions.regenerateCanvasVideo(editor, actions.canvasVideoNode(editor, 'clip')!, '海浪')
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ inputImageDataUrls: [] }),
    )
  })

  it('can drop the original frames and generate from text on purpose', async () => {
    addImage('first', 0)
    addVideo('clip', { ...GENERATED, firstFrameId: 'first' })
    await actions.regenerateCanvasVideo(editor, actions.canvasVideoNode(editor, 'clip')!, '海浪', {
      keepFrames: false,
    })
    await settle()
    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ inputImageDataUrls: [] }),
    )
  })

  it('does not spend anything once the dialog was closed while frames were being prepared', async () => {
    addImage('first', 0)
    addVideo('clip', { ...GENERATED, firstFrameId: 'first' })
    vi.spyOn(editor, 'toImage').mockResolvedValue('data:image/png;base64,Zg==')
    const accepted = await actions.regenerateCanvasVideo(
      editor,
      actions.canvasVideoNode(editor, 'clip')!,
      '海浪',
      { isCurrent: () => false },
    )
    expect(accepted).toBe(false)
    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
    expect(editor.getPlaceholders()).toHaveLength(0)
  })

  it('explains in the dialog when the chosen model cannot take the kept frames', () => {
    expect(actions.regenerateFrameRefusal(1, GROK)).toBeNull()
    expect(actions.regenerateFrameRefusal(2, GROK)).toContain('Grok')
    expect(actions.regenerateFrameRefusal(0, GROK)).toBeNull()
  })

  it('prefills the full prompt a canvas clip was generated with, annotation text included', () => {
    addVideo('clip', GENERATED, { prompt: '让她转身\n慢镜头', userPrompt: '慢镜头' })
    expect(actions.canvasVideoNode(editor, 'clip')!.userPrompt).toBe('让她转身\n慢镜头')
    addVideo('agent', GENERATED, { prompt: '视频：海边', userPrompt: '黄昏的海边，慢跑' })
    expect(actions.canvasVideoNode(editor, 'agent')!.userPrompt).toBe('黄昏的海边，慢跑')
  })

  it('refuses an empty prompt before anything is submitted', async () => {
    addVideo('agent', GENERATED, { prompt: '海边日落视频' })
    const node = actions.canvasVideoNode(editor, 'agent')!
    expect(node.userPrompt).toBeNull()
    expect(await actions.regenerateCanvasVideo(editor, node, '  ')).toBe(false)
    expect(mocks.submitVideoRequest).not.toHaveBeenCalled()
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
