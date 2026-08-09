import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasEditor, PlaceholderView } from '../../../../features/canvas/lib/editor'

const { callImageApiMock, guardMock, showToastMock } = vi.hoisted(() => ({
  callImageApiMock: vi.fn(),
  guardMock: vi.fn(({ model }: { model: string }) =>
    model === 'current-model' ? { blocked: true, disabledReason: 'blocked' } : { blocked: false },
  ),
  showToastMock: vi.fn(),
}))

vi.mock('../../../../lib/api', () => ({ callImageApi: callImageApiMock }))
vi.mock('../../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({ id: 'active-profile' }),
  clientProfileToApiProfile: () => ({ model: 'current-model' }),
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: guardMock,
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: vi.fn(),
}))
vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ settings: {}, showToast: showToastMock }) },
  addCompletedCanvasTask: vi.fn(),
}))

import { retryCanvasTask } from '../../../../features/canvas/lib/submitFromCanvas'

beforeEach(() => {
  callImageApiMock.mockClear()
  guardMock.mockClear()
  showToastMock.mockClear()
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
