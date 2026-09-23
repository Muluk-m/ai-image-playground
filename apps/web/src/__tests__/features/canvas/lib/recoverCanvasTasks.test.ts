import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CanvasEditor,
  CanvasTaskMeta,
  PlaceholderView,
} from '../../../../features/canvas/lib/editor'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../../../lib/apiProfiles'
import { setChannels } from '../../../../lib/channels/channelStore'
import type { PublicChannel } from '../../../../lib/channels/types'

const QUEUE_CHANNEL: PublicChannel = {
  id: 'queue-channel',
  kind: 'openai-queue',
  label: 'Queue',
  models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
  defaults: { apiMode: 'images', timeout: 600 },
}

const settings = vi.hoisted(() => ({ value: {} as unknown }))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ settings: settings.value, params: {}, showToast: vi.fn() }) },
  addCompletedCanvasTask: vi.fn(async () => {}),
}))

import { recoverCanvasTasks } from '../../../../features/canvas/lib/recoverCanvasTasks'

function ph(id: string, status: PlaceholderView['status'], meta: CanvasTaskMeta): PlaceholderView {
  return { id, x: 0, y: 0, w: 360, h: 360, status, message: '', meta }
}

function makeEditor(placeholders: PlaceholderView[]) {
  const updatePlaceholder = vi.fn()
  const deleteElement = vi.fn()
  const editor = {
    getPlaceholders: () => placeholders,
    getPlaceholder: (id: string) => placeholders.find((p) => p.id === id),
    updatePlaceholder,
    deleteElement,
  } as unknown as CanvasEditor
  return { editor, updatePlaceholder, deleteElement }
}

/** 续跑只打 status：请求出没出去就是「有没有接着跑」本身。 */
function stubQueue() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ request_id: 'req-1', status: 'in_progress', submitted_at: 0 }),
    )
}

beforeEach(() => {
  vi.restoreAllMocks()
  setChannels([QUEUE_CHANNEL])
  settings.value = normalizeSettings({
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
})

describe('recoverCanvasTasks 恢复分支判定（决策 7）', () => {
  it('builtin-edge + bffRequestId → 接着续 poll，不标失效', async () => {
    const fetchMock = stubQueue()
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:a', 'loading', {
        taskId: 't1',
        clientRequestId: 'c1',
        bffRequestId: 'req-1',
        source: 'builtin-edge',
        prompt: 'hi',
        params: { size: '1536x1024', n: 1 } as CanvasTaskMeta['params'],
      }),
    ])

    recoverCanvasTasks(editor)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/req-1/status')
    expect(updatePlaceholder).not.toHaveBeenCalled()
  })

  it('builtin-edge 仅 clientRequestId（未确认窗口）→ 标记手动重试，不自动重提交', () => {
    const fetchMock = stubQueue()
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:b', 'loading', {
        taskId: 't2',
        clientRequestId: 'c2',
        source: 'builtin-edge',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).toHaveBeenCalledTimes(1)
    const [id, patch] = updatePlaceholder.mock.calls[0] as [
      string,
      { status: string; message: string },
    ]
    expect(id).toBe('el:b')
    expect(patch.status).toBe('stale')
    expect(patch.message).toContain('未确认')
  })

  it('user-byok（无恢复能力）→ 标记失效', () => {
    const fetchMock = stubQueue()
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:c', 'loading', {
        taskId: 't3',
        clientRequestId: 'c3',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).toHaveBeenCalledTimes(1)
    const patch = updatePlaceholder.mock.calls[0][1] as { status: string; message: string }
    expect(patch.status).toBe('stale')
    expect(patch.message).toContain('BYOK')
  })

  it('智能体占的位 → 直接删掉，不当成可续的画布任务', () => {
    const fetchMock = stubQueue()
    const { editor, updatePlaceholder, deleteElement } = makeEditor([
      ph('el:agent', 'loading', {
        taskId: '',
        clientRequestId: '',
        source: 'builtin-edge',
        prompt: '',
        agent: true,
      }),
    ])

    recoverCanvasTasks(editor)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).not.toHaveBeenCalled()
    expect(deleteElement).toHaveBeenCalledWith('el:agent', { history: false })
  })

  it('非运行态占位框（error）→ 跳过，不动它', () => {
    const fetchMock = stubQueue()
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:d', 'error', {
        taskId: 't4',
        clientRequestId: 'c4',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).not.toHaveBeenCalled()
  })
})
