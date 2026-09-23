import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setSignedIn } from '../../../../auth/loginPrompt'
import type { CanvasEditor, PlaceholderView } from '../../../../features/canvas/lib/editor'
import { Box } from '../../../../features/canvas/lib/geometry'
import { DEFAULT_PARAMS } from '../../../../types'

const { callImageApiMock, createPlaceholderMock, guardMock, showToastMock } = vi.hoisted(() => ({
  callImageApiMock: vi.fn(),
  createPlaceholderMock: vi.fn(() => 'placeholder-1'),
  guardMock: vi.fn(({ model }: { model: string }) =>
    model === 'current-model' ? { blocked: true, disabledReason: 'blocked' } : { blocked: false },
  ),
  showToastMock: vi.fn(),
}))

vi.mock('../../../../lib/api', () => ({ callImageApi: callImageApiMock }))
vi.mock('../../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({ id: 'active-profile', source: 'builtin-edge' }),
  clientProfileToApiProfile: () => ({
    id: 'active-profile',
    name: 'Active profile',
    model: 'current-model',
    provider: 'openai-compat',
  }),
}))
vi.mock('../../../../lib/clientCapabilities', () => ({
  isClientCapabilityEnabled: () => true,
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: guardMock,
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: vi.fn(),
}))
vi.mock('../../../../store', () => ({
  useStore: {
    getState: () => ({
      settings: {},
      params: { ...DEFAULT_PARAMS, n: 4 },
      showToast: showToastMock,
    }),
  },
  addCompletedCanvasTask: vi.fn(),
}))

import { retryCanvasTask, submitFromCanvas } from '../../../../features/canvas/lib/submitFromCanvas'

beforeEach(() => {
  // 这里把所有能力都开着（含 accounts:login），测的是登录用户那条路。
  setSignedIn(true)
  callImageApiMock.mockClear()
  guardMock.mockClear()
  showToastMock.mockClear()
})

describe('submitFromCanvas billing reservation', () => {
  it('submits one server task carrying the full billed quantity', async () => {
    guardMock.mockReturnValueOnce({ blocked: false })
    callImageApiMock.mockResolvedValue({ images: [] })
    const editor = {
      createPlaceholder: createPlaceholderMock,
      updatePlaceholder: vi.fn(),
      getSelectedIds: () => [],
      getViewportPageBounds: () => ({ midX: 500, midY: 400, w: 4000 }),
      getOccupiedBounds: () => [],
    } as unknown as CanvasEditor

    await submitFromCanvas(editor, 'draw')

    expect(guardMock).toHaveBeenCalledWith({ model: 'current-model', quantity: 4 })
    expect(createPlaceholderMock).toHaveBeenCalledTimes(1)
    expect(callImageApiMock).toHaveBeenCalledTimes(1)
    expect(callImageApiMock.mock.calls[0]?.[0].params.n).toBe(4)
  })
})

describe('retryCanvasTask billing guard', () => {
  it('prices the active model that the retry will dispatch', () => {
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
        profileView: {
          apiProvider: 'openai-compat',
          apiProfileId: 'old-profile',
          apiProfileName: 'Old profile',
          apiModel: 'old-model',
        },
      },
    } satisfies PlaceholderView
    const editor = {} as CanvasEditor

    retryCanvasTask(editor, placeholder)

    expect(showToastMock).toHaveBeenCalledWith('blocked', 'error')
    expect(callImageApiMock).not.toHaveBeenCalled()
  })
})

describe('failed canvas image task', () => {
  it('keeps its input images in memory so the error placeholder can retry them', async () => {
    const { getCanvasTask } = await import('../../../../features/canvas/lib/canvasTaskRuntime')
    guardMock.mockReturnValueOnce({ blocked: false })
    callImageApiMock.mockRejectedValueOnce(new Error('upstream timeout'))
    let meta: { taskId: string } | undefined
    const editor = {
      createPlaceholder: vi.fn((_target: unknown, created: { taskId: string }) => {
        meta = created
        return 'placeholder-2'
      }),
      updatePlaceholder: vi.fn(),
      getSelectedIds: () => [],
      getViewportPageBounds: () => ({ midX: 500, midY: 400, w: 4000 }),
      getOccupiedBounds: () => [],
    } as unknown as CanvasEditor

    await submitFromCanvas(editor, 'draw')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(meta).toBeDefined()
    expect(getCanvasTask(meta!.taskId)).toBeDefined()
  })
})

describe('per-image batch submit', () => {
  /** 两张并排的图各自成为一个输入条目（没有标注跟随）。 */
  function selectionEditor() {
    const boxes: Record<string, Box> = {
      a: new Box(0, 0, 100, 100),
      b: new Box(400, 0, 100, 100),
    }
    return {
      createPlaceholder: createPlaceholderMock,
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

  it('gives every selected image its own task with only that image as input', async () => {
    guardMock.mockReturnValue({ blocked: false })
    callImageApiMock.mockResolvedValue({ images: [] })

    await submitFromCanvas(selectionEditor(), 'crop to 3:4', { perImage: true })

    // 门禁按整批的量判：两张 × 每张 4 份。
    expect(guardMock).toHaveBeenCalledWith({ model: 'current-model', quantity: 8 })
    expect(callImageApiMock).toHaveBeenCalledTimes(2)
    expect(callImageApiMock.mock.calls.map((call) => call[0].inputImageDataUrls)).toEqual([
      ['data:image/png;base64,a'],
      ['data:image/png;base64,b'],
    ])
    expect(callImageApiMock.mock.calls.every((call) => call[0].params.n === 4)).toBe(true)
  })

  it('still merges the selection into one multi-reference task when batching is off', async () => {
    guardMock.mockReturnValue({ blocked: false })
    callImageApiMock.mockResolvedValue({ images: [] })

    await submitFromCanvas(selectionEditor(), 'blend these')

    expect(guardMock).toHaveBeenCalledWith({ model: 'current-model', quantity: 4 })
    expect(callImageApiMock).toHaveBeenCalledTimes(1)
    expect(callImageApiMock.mock.calls[0]?.[0].inputImageDataUrls).toHaveLength(2)
  })
})
