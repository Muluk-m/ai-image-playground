// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const GROK = 'grok-imagine-video'
const VEO_LITE = 'veo-3.1-lite-generate-preview'

vi.mock('../../../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  videoModelOptions: () =>
    [GROK, VEO_LITE].map((modelId) => ({
      channelId: 'gateway',
      modelId,
      label: VIDEO_MODEL_SUPPORT[modelId]!.label,
      support: VIDEO_MODEL_SUPPORT[modelId]!,
    })),
  isVideoModeAvailable: () => true,
}))

const { loadCanvasVideoIntoComposer, canvasVideoNode } = await import(
  '../../../../features/canvas/lib/canvasVideoActions'
)
const { useVideoStore } = await import('../../../../features/video/store')

let editor: CanvasEditor

function addVideo(generation: object) {
  editor.doc.addElements([
    {
      id: 'clip',
      type: 'image',
      x: 0,
      y: 0,
      width: 180,
      height: 320,
      rotation: 0,
      fileId: 'poster',
      meta: { userPrompt: '海浪' },
      video: { taskId: 't', outputIndex: 0, generation: generation as never },
    },
  ])
}

beforeEach(() => {
  editor = new CanvasEditor(new CanvasDoc())
  // 草稿先停在另一个模型、另一套档位上，才看得出载回是不是真的落进了导演台的草稿。
  useVideoStore.setState({
    draft: {
      ...useVideoStore.getState().draft,
      model: GROK,
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
    },
  })
})

describe('重新生成落进导演台的真实草稿', () => {
  it('restores a Veo 1080p clip without the resolution clamping its duration away', () => {
    addVideo({ model: VEO_LITE, duration: 8, aspectRatio: '9:16', resolution: '1080p' })

    loadCanvasVideoIntoComposer(editor, canvasVideoNode(editor, 'clip')!)

    expect(useVideoStore.getState().draft).toMatchObject({
      model: VEO_LITE,
      duration: 8,
      aspectRatio: '9:16',
      resolution: '1080p',
    })
  })

  it('restores a Grok clip with its own duration', () => {
    addVideo({ model: GROK, duration: 10, aspectRatio: '1:1', resolution: '720p' })

    loadCanvasVideoIntoComposer(editor, canvasVideoNode(editor, 'clip')!)

    expect(useVideoStore.getState().draft).toMatchObject({
      model: GROK,
      duration: 10,
      aspectRatio: '1:1',
      resolution: '720p',
    })
  })
})
