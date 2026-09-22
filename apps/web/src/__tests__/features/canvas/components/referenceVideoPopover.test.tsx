// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { chooseOption, pointer, stubPointerApis } from '../../../helpers/radix'

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5-flash'
const SEEDANCE = 'doubao-seedance-2-0-mini-260615'
const mocks = vi.hoisted(() => ({
  submitVideoRequest: vi.fn(async () => 'req-1'),
  showToast: vi.fn(),
}))

vi.mock('../../../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  videoModelOptions: () => [
    { channelId: 'agnes', modelId: AGNES, label: 'Agnes', support: VIDEO_MODEL_SUPPORT[AGNES]! },
    { channelId: 'grok', modelId: GROK, label: 'Grok', support: VIDEO_MODEL_SUPPORT[GROK]! },
    {
      channelId: 'ark',
      modelId: SEEDANCE,
      label: 'Seedance',
      support: VIDEO_MODEL_SUPPORT[SEEDANCE]!,
    },
  ],
  isVideoModeAvailable: () => true,
}))
vi.mock('../../../../lib/channels/channelStore', () => ({
  getStoredChannel: (id: string) => ({ id, kind: 'openai-queue' }),
  getStoredChannels: () => [],
}))
vi.mock('../../../../lib/channels/queueClient', () => ({
  submitVideoRequest: mocks.submitVideoRequest,
  // 出片不在这里测：让它一直等着，占位框留在原处。
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

const { default: CanvasVideoToolbar } = await import(
  '../../../../features/canvas/components/CanvasVideoToolbar'
)
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

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (one) => one.getAttribute('aria-label') === text || one.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found as HTMLButtonElement
}

function order(): string[] {
  return Array.from(document.querySelectorAll('[data-input-id]')).map(
    (one) => one.getAttribute('data-input-id') ?? '',
  )
}

function type(text: string): void {
  const area = document.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  stubPointerApis()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  useStore.setState({ showToast: mocks.showToast })
  useVideoStore.setState({ draft: { ...INITIAL_VIDEO_DRAFT, model: AGNES } })
  // 「用 N 张图生成视频」只在视频画布里出现。
  useCanvasProjectStore.setState({
    projects: [
      {
        id: 'video-project',
        name: '视频画布',
        customName: false,
        conversationId: null,
        sceneKey: 'scene:video-project',
        createdAt: 0,
        updatedAt: 0,
        hasContent: true,
        kind: 'video',
      },
    ],
    activeId: 'video-project',
  })
  const doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  vi.spyOn(editor, 'toImage').mockImplementation(async (ids) => `data:image/png;base64,${ids[0]}`)
  addImage('c', 400)
  addImage('a', 0)
  addImage('b', 200)
  editor.setSelectedElements(['c', 'a', 'b'])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CanvasVideoToolbar editor={editor} />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  mocks.submitVideoRequest.mockClear()
  mocks.showToast.mockClear()
  vi.unstubAllGlobals()
})

describe('选中即参考', () => {
  it('stays out of image canvases: several selected images there are for editing, not video', () => {
    act(() =>
      useCanvasProjectStore.setState((state) => ({
        projects: state.projects.map((one) => ({ ...one, kind: 'image' as const })),
      })),
    )
    expect(host.querySelector('[role=toolbar]')).toBeNull()
  })

  it('opens from the selection toolbar with the images left to right, on a model that takes references', () => {
    act(() => button('用 3 张图生成视频').click())

    expect(order()).toEqual(['a', 'b', 'c'])
    expect(useVideoStore.getState().draft.model).toBe(GROK)
    for (const no of [1, 2, 3])
      expect(document.querySelector(`[aria-label="第 ${no} 张的用法"]`)?.textContent).toBe('参考图')
  })

  it('submits the reordered, role-marked images and places a placeholder', async () => {
    act(() => button('用 3 张图生成视频').click())
    act(() => button('第 3 张前移').click())
    expect(order()).toEqual(['a', 'c', 'b'])
    chooseOption('第 1 张的用法', '首帧')
    type('图2 里的球拍飞进来')
    await act(async () => button('生成视频').click())
    await settle()

    expect(mocks.submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: GROK,
        prompt: '图2 里的球拍飞进来',
        inputImageDataUrls: [
          'data:image/png;base64,a',
          'data:image/png;base64,c',
          'data:image/png;base64,b',
        ],
        video: expect.objectContaining({
          resolution: '720p',
          first_frame_index: 0,
          reference_image_indices: [1, 2],
        }),
      }),
    )
    expect(editor.getPlaceholders()).toHaveLength(1)
    expect(document.querySelector('[data-input-id]')).toBeNull()
  })

  it('explains and blocks a model that cannot take references', () => {
    act(() => button('用 3 张图生成视频').click())
    chooseOption('模型', 'Agnes（不支持参考图）')
    type('出场')

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('不支持参考图')
    expect(button('生成视频').disabled).toBe(true)
  })

  it('explains a resolution above the reference cap', () => {
    act(() => button('用 3 张图生成视频').click())
    useVideoStore.getState().setResolution('1080p')
    act(() => root.render(<CanvasVideoToolbar editor={editor} />))

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('720p')
  })

  it('offers only references on a model that cannot combine them with frames', () => {
    act(() => button('用 3 张图生成视频').click())
    chooseOption('模型', 'Seedance')
    const trigger = document.querySelector<HTMLElement>('[aria-label="第 1 张的用法"]')!
    act(() => {
      trigger.dispatchEvent(pointer('pointerdown'))
    })
    const options = Array.from(document.querySelectorAll('[role="option"]')).map((one) =>
      one.textContent?.trim(),
    )
    expect(options).toEqual(['参考图'])
  })

  it('offers the entry only for two or more images', () => {
    act(() => editor.setSelectedElements(['a']))
    act(() => root.render(<CanvasVideoToolbar editor={editor} />))
    expect(document.querySelector('[aria-label="用选中的图生成视频"]')).toBeNull()
  })

  it('restores the shared draft when closed without submitting', () => {
    act(() => button('用 3 张图生成视频').click())
    expect(useVideoStore.getState().draft.model).toBe(GROK)
    act(() => root.unmount())
    root = createRoot(host)
    expect(useVideoStore.getState().draft.model).toBe(AGNES)
  })
})
