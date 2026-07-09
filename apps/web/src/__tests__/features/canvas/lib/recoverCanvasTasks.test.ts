import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CanvasEditor,
  CanvasTaskMeta,
  PlaceholderView,
} from '../../../../features/canvas/lib/editor'

// resume 用永不 resolve 的 promise：只断言「是否被调用」，不驱动后续异步。
const { resumeMock } = vi.hoisted(() => ({
  resumeMock: vi.fn((_opts: unknown, _requestId: string) => new Promise<never>(() => {})),
}))
vi.mock('../../../../lib/api', () => ({ resumeQueueImageApi: resumeMock }))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ settings: {}, params: {} }) },
  addCompletedCanvasTask: vi.fn(async () => {}),
}))

import { recoverCanvasTasks } from '../../../../features/canvas/lib/recoverCanvasTasks'

function ph(id: string, status: PlaceholderView['status'], meta: CanvasTaskMeta): PlaceholderView {
  return { id, x: 0, y: 0, w: 360, h: 360, status, message: '', meta }
}

function makeEditor(placeholders: PlaceholderView[]) {
  const updatePlaceholder = vi.fn()
  const editor = {
    getPlaceholders: () => placeholders,
    getPlaceholder: (id: string) => placeholders.find((p) => p.id === id),
    updatePlaceholder,
  } as unknown as CanvasEditor
  return { editor, updatePlaceholder }
}

beforeEach(() => {
  resumeMock.mockClear()
})

describe('recoverCanvasTasks 恢复分支判定（决策 7）', () => {
  it('builtin-edge + bffRequestId → resume 续 poll（用 meta 参数快照），不标失效', () => {
    const snapshot = { size: '1536x1024', n: 1 } as CanvasTaskMeta['params']
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:a', 'loading', {
        taskId: 't1',
        clientRequestId: 'c1',
        bffRequestId: 'req-1',
        source: 'builtin-edge',
        prompt: 'hi',
        params: snapshot,
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).toHaveBeenCalledTimes(1)
    expect(resumeMock.mock.calls[0][1]).toBe('req-1')
    // 恢复用发起时的参数快照，而非当前 store 参数
    expect((resumeMock.mock.calls[0][0] as { params: unknown }).params).toEqual(snapshot)
    expect(updatePlaceholder).not.toHaveBeenCalled()
  })

  it('builtin-edge 仅 clientRequestId（未确认窗口）→ 标记手动重试，不自动重提交', () => {
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:b', 'loading', {
        taskId: 't2',
        clientRequestId: 'c2',
        source: 'builtin-edge',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
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
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:c', 'loading', {
        taskId: 't3',
        clientRequestId: 'c3',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).toHaveBeenCalledTimes(1)
    const patch = updatePlaceholder.mock.calls[0][1] as { status: string; message: string }
    expect(patch.status).toBe('stale')
    expect(patch.message).toContain('BYOK')
  })

  it('非运行态占位框（error）→ 跳过，不动它', () => {
    const { editor, updatePlaceholder } = makeEditor([
      ph('el:d', 'error', {
        taskId: 't4',
        clientRequestId: 'c4',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
    expect(updatePlaceholder).not.toHaveBeenCalled()
  })
})
