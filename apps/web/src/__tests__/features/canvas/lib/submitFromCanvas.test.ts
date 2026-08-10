import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasEditor, PlaceholderView } from '../../../../features/canvas/lib/editor'
import { DEFAULT_PARAMS } from '../../../../types'

const { callImageApiMock, clientCapabilityMock, createPlaceholderMock, guardMock, showToastMock } =
  vi.hoisted(() => ({
    callImageApiMock: vi.fn(),
    clientCapabilityMock: vi.fn(() => true),
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
  isClientCapabilityEnabled: clientCapabilityMock,
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
      getViewportPageBounds: () => ({ midX: 500, midY: 400 }),
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
