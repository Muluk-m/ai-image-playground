import type { Editor } from 'tldraw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// placeholderShapeOps 会从 'tldraw' 取 AssetRecordType / createShapeId（运行时值）；
// node 环境不加载真 tldraw，桩掉这两个即可（本用例不触发 placeResults）。
vi.mock('tldraw', () => ({
  AssetRecordType: { createId: () => 'asset:test' },
  createShapeId: () => 'shape:test',
}))

// resume 用永不 resolve 的 promise：只断言「是否被调用」，不驱动后续异步。
const { resumeMock } = vi.hoisted(() => ({
  resumeMock: vi.fn((_opts: unknown, _requestId: string) => new Promise<never>(() => {})),
}))
vi.mock('../../../../lib/api', () => ({ resumeQueueImageApi: resumeMock }))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ settings: {}, params: {} }) },
}))

import { recoverCanvasTasks } from '../../../../features/canvas/lib/recoverCanvasTasks'

interface PlaceholderShape {
  id: string
  type: string
  x: number
  y: number
  props: { w: number; h: number; status: string; message: string }
  meta: Record<string, unknown>
}

function ph(id: string, status: string, meta: Record<string, unknown>): PlaceholderShape {
  return {
    id,
    type: 'generation-placeholder',
    x: 0,
    y: 0,
    props: { w: 360, h: 360, status, message: '' },
    meta,
  }
}

function makeEditor(shapes: PlaceholderShape[]) {
  const updateShape = vi.fn()
  const editor = {
    getCurrentPageShapes: () => shapes,
    getShape: (id: string) => shapes.find((s) => s.id === id),
    updateShape,
  } as unknown as Editor
  return { editor, updateShape }
}

beforeEach(() => {
  resumeMock.mockClear()
})

describe('recoverCanvasTasks 恢复分支判定（决策 7）', () => {
  it('builtin-edge + bffRequestId → resume 续 poll，不标失效', () => {
    const { editor, updateShape } = makeEditor([
      ph('shape:a', 'loading', {
        taskId: 't1',
        clientRequestId: 'c1',
        bffRequestId: 'req-1',
        source: 'builtin-edge',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).toHaveBeenCalledTimes(1)
    expect(resumeMock.mock.calls[0][1]).toBe('req-1')
    expect(updateShape).not.toHaveBeenCalled()
  })

  it('builtin-edge 仅 clientRequestId（未确认窗口）→ 标记手动重试，不自动重提交', () => {
    const { editor, updateShape } = makeEditor([
      ph('shape:b', 'loading', {
        taskId: 't2',
        clientRequestId: 'c2',
        source: 'builtin-edge',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
    expect(updateShape).toHaveBeenCalledTimes(1)
    const patch = updateShape.mock.calls[0][0] as { props: { status: string; message: string } }
    expect(patch.props.status).toBe('stale')
    expect(patch.props.message).toContain('未确认')
  })

  it('user-byok（无恢复能力）→ 标记失效', () => {
    const { editor, updateShape } = makeEditor([
      ph('shape:c', 'loading', {
        taskId: 't3',
        clientRequestId: 'c3',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
    expect(updateShape).toHaveBeenCalledTimes(1)
    const patch = updateShape.mock.calls[0][0] as { props: { status: string; message: string } }
    expect(patch.props.status).toBe('stale')
    expect(patch.props.message).toContain('BYOK')
  })

  it('非运行态占位框（error）→ 跳过，不动它', () => {
    const { editor, updateShape } = makeEditor([
      ph('shape:d', 'error', {
        taskId: 't4',
        clientRequestId: 'c4',
        source: 'user-byok',
        prompt: 'hi',
      }),
    ])

    recoverCanvasTasks(editor)

    expect(resumeMock).not.toHaveBeenCalled()
    expect(updateShape).not.toHaveBeenCalled()
  })
})
