import { canvasOrigin, insertCanvasNode, readCanvasDocument } from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { resumeNodeVideos, submitNodeVideo } from '../../../../features/canvas/lib/nodeCanvasVideo'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => 'request-1'),
  job: vi.fn(),
  guard: vi.fn(() => true),
  toast: vi.fn(),
}))
vi.mock('../../../../lib/generationJob', () => ({
  superviseGeneration: (_id: string, _sink: unknown, work: () => Promise<void>) => {
    mocks.job(work)
    return Promise.resolve()
  },
}))
vi.mock('../../../../lib/channels/queueClient', () => ({
  submitVideoRequest: mocks.submit,
  awaitQueueOutputs: async () => [],
}))
vi.mock('../../../../lib/channels/channelStore', () => ({
  getStoredChannel: () => ({ id: 'video' }),
}))
vi.mock('../../../../lib/channels/videoChannels', () => ({
  videoModelOptions: () => [{ modelId: 'model', channelId: 'video' }],
}))
vi.mock('../../../../features/video/store', () => ({
  useVideoStore: {
    getState: () => ({
      draft: { model: 'model', duration: 5, aspectRatio: '16:9', resolution: '720p' },
    }),
  },
}))
vi.mock('../../../../features/canvas/lib/videoRejection', () => ({
  videoOptionRejection: () => null,
}))
vi.mock('../../../../features/canvas/lib/submitVideoFromCanvas', () => ({
  guardAllows: mocks.guard,
  canvasVideoPromptRefusal: () => null,
}))
vi.mock('../../../../lib/privateOverlay', () => ({ notifyPrivateSubmissionAccepted: vi.fn() }))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: mocks.toast }) } }))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({ videoOutputFrame: vi.fn() }))
function fixture() {
  const doc = new Y.Doc()
  insertCanvasNode(
    doc,
    {
      id: 'video',
      type: 'image',
      x: 0,
      y: 0,
      width: 360,
      height: 240,
      data: { meta: { nodeKind: 'video' } },
    },
    canvasOrigin('user', 'test'),
  )
  return { doc, editor: new CanvasEditor(new CanvasDoc()) }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.guard.mockReturnValue(true)
})
describe('node video submission', () => {
  it('orders first and last frames before references and persists the accepted request for reload', async () => {
    const { doc, editor } = fixture()
    const refs = ['ref', 'last', 'first'].map((id) => ({
      id,
      kind: 'image' as const,
      label: id,
      fileId: id,
    }))
    expect(
      submitNodeVideo(
        editor,
        doc,
        'video',
        'pan slowly',
        refs,
        { first: 'first', last: 'last' },
        { ref: 'data:ref', last: 'data:last', first: 'data:first' },
      ),
    ).toBe(true)
    await expect(mocks.job.mock.calls[0]![0]()).rejects.toThrow()
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImageDataUrls: ['data:first', 'data:last', 'data:ref'],
        video: expect.objectContaining({
          first_frame_index: 0,
          last_frame_index: 1,
          reference_image_indices: [2],
        }),
      }),
    )
    expect(readCanvasDocument(doc).nodes[0]!.data).toMatchObject({
      pending: { meta: { bffRequestId: 'request-1', nodeVideo: true } },
    })
  })
  it('does not start a request with missing media or a blocked submission guard', () => {
    const { doc, editor } = fixture()
    expect(
      submitNodeVideo(
        editor,
        doc,
        'video',
        'move',
        [{ id: 'missing', kind: 'image', label: '' }],
        {},
        {},
      ),
    ).toBe(false)
    mocks.guard.mockReturnValue(false)
    expect(submitNodeVideo(editor, doc, 'video', 'move', [], {}, {})).toBe(false)
    expect(mocks.job).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
  })
  it('does not resubmit an unconfirmed job after reload', () => {
    const { doc, editor } = fixture()
    submitNodeVideo(editor, doc, 'video', 'move', [], {}, {})
    mocks.job.mockClear()
    resumeNodeVideos(editor, doc)
    expect(mocks.job).not.toHaveBeenCalled()
    expect(readCanvasDocument(doc).nodes[0]!.data).toMatchObject({ pending: { status: 'stale' } })
  })
})
