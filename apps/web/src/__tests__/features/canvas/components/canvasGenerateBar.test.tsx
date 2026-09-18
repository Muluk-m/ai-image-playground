// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubPointerApis } from '../../../helpers/radix'

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5-flash'
const mocks = vi.hoisted(() => ({
  submitVideoRequest: vi.fn(async () => 'req-1'),
  showToast: vi.fn(),
}))

vi.mock('../../../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  videoModelOptions: () => [
    { channelId: 'grok', modelId: GROK, label: 'Grok', support: VIDEO_MODEL_SUPPORT[GROK]! },
    { channelId: 'agnes', modelId: AGNES, label: 'Agnes', support: VIDEO_MODEL_SUPPORT[AGNES]! },
  ],
  isVideoModeAvailable: () => true,
}))
vi.mock('../../../../lib/channels/channelStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStoredChannel: (id: string) => ({ id, kind: 'openai-queue' }),
}))
vi.mock('../../../../lib/channels/queueClient', () => ({
  submitVideoRequest: mocks.submitVideoRequest,
  awaitQueueOutputs: () => new Promise(() => {}),
  queueOutputUrl: () => '',
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false }),
  getPrivateSubmissionGuard: () => ({ blocked: false }),
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: vi.fn(),
}))

const { default: CanvasGenerateBar } = await import(
  '../../../../features/canvas/components/CanvasGenerateBar'
)
const { useCanvasComposer } = await import('../../../../features/canvas/composerStore')
const { CanvasDoc } = await import('../../../../features/canvas/lib/canvasDoc')
const { CanvasEditor } = await import('../../../../features/canvas/lib/editor')
const { useVideoStore, INITIAL_VIDEO_DRAFT } = await import('../../../../features/video/store')
const { useStore } = await import('../../../../store')

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let editor: InstanceType<typeof CanvasEditor>

function addImage(id: string, x: number): void {
  editor.doc.addElements([
    { id, type: 'image', x, y: 0, width: 100, height: 100, rotation: 0, fileId: `file-${id}` },
  ])
}

function type(text: string): void {
  const area = document.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function generate(): HTMLButtonElement {
  return Array.from(document.querySelectorAll('button')).find(
    (one) => one.textContent?.trim() === '生成',
  ) as HTMLButtonElement
}

beforeEach(() => {
  stubPointerApis()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  useStore.setState({ showToast: mocks.showToast })
  useCanvasComposer.setState({ mode: 'video', prompt: '' })
  const doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  vi.spyOn(editor, 'toImage').mockImplementation(async (ids) => `data:image/png;base64,${ids[0]}`)
  addImage('right', 300)
  addImage('left', 0)
  editor.setSelectedElements(['right', 'left'])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  mocks.submitVideoRequest.mockClear()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('生成栏的视频档', () => {
  it('sends the selected images as references on a model that takes them', async () => {
    useVideoStore.setState({ draft: { ...INITIAL_VIDEO_DRAFT, model: GROK } })
    act(() => root.render(<CanvasGenerateBar editor={editor} />))
    expect(document.body.textContent).toContain('选中的 2 张图作参考图')

    type('两张图一起出场')
    await act(async () => generate().click())
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: GROK,
        inputImageDataUrls: ['data:image/png;base64,left', 'data:image/png;base64,right'],
        video: expect.objectContaining({ reference_image_indices: [0, 1] }),
      }),
    )
    const [[sent]] = mocks.submitVideoRequest.mock.calls as unknown as [[{ video: object }]]
    expect(sent.video).not.toHaveProperty('first_frame_index')
  })

  it('keeps reading two images as first and last frame on a model without references', async () => {
    useVideoStore.setState({ draft: { ...INITIAL_VIDEO_DRAFT, model: AGNES } })
    act(() => root.render(<CanvasGenerateBar editor={editor} />))
    expect(document.body.textContent).toContain('左边的图作首帧、右边的图作尾帧')

    type('从左到右')
    await act(async () => generate().click())
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ first_frame_index: 0, last_frame_index: 1 }),
      }),
    )
  })

  it('explains a resolution above the reference cap and blocks generating', () => {
    useVideoStore.setState({
      draft: { ...INITIAL_VIDEO_DRAFT, model: GROK, resolution: '1080p' },
    })
    act(() => root.render(<CanvasGenerateBar editor={editor} />))
    type('出场')

    expect(document.body.textContent).toContain('720p')
    expect(generate().disabled).toBe(true)
  })
})
