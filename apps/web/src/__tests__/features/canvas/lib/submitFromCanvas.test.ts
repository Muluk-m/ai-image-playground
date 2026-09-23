import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setSignedIn } from '../../../../auth/loginPrompt'
import { retainCanvasInputs } from '../../../../features/canvas/lib/canvasGenerationSink'
import type { CanvasEditor, PlaceholderView } from '../../../../features/canvas/lib/editor'
import { Box } from '../../../../features/canvas/lib/geometry'
import { retryCanvasTask, submitFromCanvas } from '../../../../features/canvas/lib/submitFromCanvas'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../../../lib/apiProfiles'
import { setChannels } from '../../../../lib/channels/channelStore'
import type { PublicChannel } from '../../../../lib/channels/types'
import { DEFAULT_PARAMS } from '../../../../types'

/**
 * 门禁、扇出、幂等键、overlay 通知、错误码映射都归 `lib/generationJob`（那边有自己的接缝用例）。
 * 这个文件只管画布这一侧：选区变成什么样的请求、重试带回什么。所以走真的分发路径打 stub 过的
 * fetch，不 mock `callImageApi`、也不 mock 门禁。
 */
const QUEUE_CHANNEL: PublicChannel = {
  id: 'queue-channel',
  kind: 'openai-queue',
  label: 'Queue',
  models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
  defaults: { apiMode: 'images', timeout: 600 },
}

const store = vi.hoisted(() => ({
  settings: {} as unknown,
  params: {} as unknown,
  showToast: vi.fn(),
}))
vi.mock('../../../../store', () => ({
  useStore: {
    getState: () => ({
      settings: store.settings,
      params: store.params,
      showToast: store.showToast,
    }),
  },
  addCompletedCanvasTask: vi.fn(),
}))

/** 送出去的那几发 submit 请求体。submit 之后的轮询挂着不回，断言只看发了什么。 */
const submitted: Record<string, unknown>[] = []

function stubSubmit(): void {
  submitted.length = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.endsWith('/submit')) {
      submitted.push(JSON.parse(String(init?.body)))
      return Response.json({ request_id: 'rid-1', status: 'queued', submitted_at: 0 })
    }
    return new Promise<Response>(() => {})
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  setSignedIn(true)
  store.showToast.mockClear()
  // 份数固定 1：扇出规则有自己的接缝用例，这里只看选区被读成了什么输入。
  store.params = { ...DEFAULT_PARAMS, n: 1 }
  setChannels([QUEUE_CHANNEL])
  store.settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [
      {
        id: QUEUE_CHANNEL.id,
        source: 'builtin-edge',
        channelId: QUEUE_CHANNEL.id,
        selectedModelId: 'gpt-image-2',
      },
    ],
    activeProfileId: QUEUE_CHANNEL.id,
  })
  stubSubmit()
})

/** 两张并排的图各自成为一个输入条目（没有标注跟随）。 */
function selectionEditor(): CanvasEditor {
  const boxes: Record<string, Box> = {
    a: new Box(0, 0, 100, 100),
    b: new Box(400, 0, 100, 100),
  }
  return {
    createPlaceholder: vi.fn(() => 'placeholder-1'),
    updatePlaceholder: vi.fn(),
    getSelectedIds: () => ['a', 'b'],
    getElement: (id: string) => (boxes[id] ? { id, type: 'image' } : undefined),
    getElements: () => [
      { id: 'a', type: 'image' },
      { id: 'b', type: 'image' },
    ],
    getElementPageBounds: (id: string) => boxes[id],
    isPlaceholder: () => false,
    getViewportPageBounds: () => new Box(0, 0, 4000, 4000),
    getOccupiedBounds: () => [],
    toImage: vi.fn(async (ids: string[]) => `data:image/png;base64,${ids[0]}`),
  } as unknown as CanvasEditor
}

describe('选区怎么变成请求', () => {
  it('逐张模式：每张图各起一条任务，只带自己那一张', async () => {
    await submitFromCanvas(selectionEditor(), 'crop to 3:4', { perImage: true })

    await vi.waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted.map((body) => body.input_images)).toEqual([
      ['data:image/png;base64,a'],
      ['data:image/png;base64,b'],
    ])
  })

  it('不逐张时选区并成一次多图迭代', async () => {
    await submitFromCanvas(selectionEditor(), 'blend these')

    await vi.waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]!.input_images).toHaveLength(2)
  })
})

describe('失败占位框的重试', () => {
  const placeholder = {
    id: 'placeholder-1',
    x: 0,
    y: 0,
    w: 360,
    h: 360,
    status: 'error',
    message: 'failed',
    meta: {
      taskId: 'task-1',
      clientRequestId: 'request-1',
      source: 'builtin-edge',
      prompt: 'draw',
      inputCount: 1,
      params: { ...DEFAULT_PARAMS, n: 1 },
    },
  } satisfies PlaceholderView

  it('原任务的输入图还在内存里：原样带回去重发，旧占位框收掉', () => {
    retainCanvasInputs('task-1', { inputImageDataUrls: ['data:image/png;base64,kept'] })
    const deleteElement = vi.fn()
    const editor = {
      createPlaceholder: vi.fn(() => 'placeholder-2'),
      updatePlaceholder: vi.fn(),
      deleteElement,
    } as unknown as CanvasEditor

    retryCanvasTask(editor, placeholder)

    expect(deleteElement).toHaveBeenCalledWith('placeholder-1')
  })

  it('输入图已随页面关闭丢失：明确报错，不静默退化成文生图，也不动旧占位框', () => {
    const deleteElement = vi.fn()
    const createPlaceholder = vi.fn()
    const editor = { createPlaceholder, deleteElement } as unknown as CanvasEditor

    retryCanvasTask(editor, { ...placeholder, meta: { ...placeholder.meta, taskId: 'gone' } })

    expect(store.showToast).toHaveBeenCalledWith(expect.stringContaining('输入图'), 'error')
    expect(createPlaceholder).not.toHaveBeenCalled()
    expect(deleteElement).not.toHaveBeenCalled()
  })
})
