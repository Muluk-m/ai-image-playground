// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MODEL = 'grok-imagine-video'
const mocks = vi.hoisted(() => ({
  regenerate: vi.fn(),
}))

vi.mock('../../../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  videoModelOptions: () => [
    { channelId: 'c', modelId: MODEL, label: 'Grok', support: VIDEO_MODEL_SUPPORT[MODEL]! },
  ],
  isVideoModeAvailable: () => true,
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false }),
}))
vi.mock('../../../../features/canvas/lib/canvasVideoActions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  regenerateCanvasVideo: mocks.regenerate,
}))

const { default: RegenerateVideoPopover } = await import(
  '../../../../features/canvas/components/RegenerateVideoPopover'
)
const { CanvasDoc } = await import('../../../../features/canvas/lib/canvasDoc')
const { CanvasEditor } = await import('../../../../features/canvas/lib/editor')
const { useVideoStore } = await import('../../../../features/video/store')

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const node = {
  id: 'clip',
  userPrompt: '海浪',
  video: {
    taskId: 't',
    outputIndex: 0,
    generation: { model: MODEL, duration: 15, aspectRatio: '9:16', resolution: '720p' },
  },
} as const

function submitButton() {
  return Array.from(document.querySelectorAll('button')).find((one) =>
    one.textContent?.includes('重新生成'),
  ) as HTMLButtonElement
}

beforeEach(() => {
  useVideoStore.setState({
    draft: { ...useVideoStore.getState().draft, model: MODEL, duration: 5, aspectRatio: '16:9' },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  mocks.regenerate.mockReset()
})

describe('改参数重新生成弹窗', () => {
  it('submits once even when clicked twice while the first submit is pending', async () => {
    let finish!: (value: boolean) => void
    mocks.regenerate.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    act(() =>
      root.render(
        <RegenerateVideoPopover
          editor={new CanvasEditor(new CanvasDoc())}
          node={node}
          onClose={() => {}}
        />,
      ),
    )
    act(() => submitButton().click())
    act(() => submitButton().click())
    expect(mocks.regenerate).toHaveBeenCalledTimes(1)
    await act(async () => finish(false))
  })

  it('restores the shared video draft when closed without submitting', () => {
    const editor = new CanvasEditor(new CanvasDoc())
    act(() =>
      root.render(<RegenerateVideoPopover editor={editor} node={node} onClose={() => {}} />),
    )
    expect(useVideoStore.getState().draft.duration).toBe(15)
    act(() => root.render(<div />))
    expect(useVideoStore.getState().draft).toMatchObject({ duration: 5, aspectRatio: '16:9' })
  })
})
