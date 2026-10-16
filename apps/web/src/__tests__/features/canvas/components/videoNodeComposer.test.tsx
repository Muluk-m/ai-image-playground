// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import VideoNodeComposer from '../../../../features/canvas/components/VideoNodeComposer'
import type { VideoDraft } from '../../../../features/video/types'
import { stubPointerApis } from '../../../helpers/radix'

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  send: vi.fn(),
  toast: vi.fn(),
  voices: [] as string[],
}))
const basic = 'grok-imagine-video-1.5-lite'
const frames = 'agnes-video-2.5-flash'
vi.mock('../../../../lib/channels/videoChannels', () => ({
  videoModelOptions: () =>
    [basic, frames, 'grok-imagine-video'].map((modelId) => ({
      modelId,
      support: VIDEO_MODEL_SUPPORT[modelId],
    })),
}))
vi.mock('../../../../features/video/store', () => ({
  useVideoStore: (selector: (state: { draft: VideoDraft }) => unknown) =>
    selector({
      draft: {
        model: basic,
        duration: 5,
        aspectRatio: '16:9',
        resolution: '720p',
        voices: mocks.voices,
      },
    }),
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, estimatedCredits: 20 }),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: mocks.toast }) } }))
vi.mock('../../../../features/canvas/lib/importImages', () => ({ fileToDataUrl: mocks.upload }))
vi.mock('../../../../features/canvas/components/NodeMediaImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))
vi.mock('../../../../features/canvas/components/NodeComposerFrame', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../../components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}))
vi.mock('../../../../features/canvas/components/CanvasVideoParams', () => ({
  default: ({
    controlled,
  }: {
    controlled: { draft: VideoDraft; onChange: (patch: Partial<VideoDraft>) => void }
  }) => (
    <button onClick={() => controlled.onChange({ model: frames })}>
      Change model
      <span data-quality={controlled.draft.resolution} />
    </button>
  ),
}))
let host: HTMLDivElement
let root: Root
let scope: object
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  scope = {}
  mocks.upload.mockResolvedValue('data:image/png;base64,upload')
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
function Fixture({
  initial = {},
  onPickReference,
}: {
  initial?: Record<string, string>
  onPickReference?: (slot?: 'first' | 'last') => void
}) {
  const [meta, onMeta] = useState<Record<string, string>>(initial)
  return (
    <VideoNodeComposer
      document={scope}
      nodeId="video"
      value="pan slowly"
      onChange={() => {}}
      onSubmit={mocks.send}
      busy={false}
      referenceTools={null}
      onPickReference={onPickReference}
      references={['one', 'two'].map((id) => ({ id, fileId: id, kind: 'image', label: id }))}
      files={{ one: 'data:one', two: 'data:two' }}
      meta={meta}
      onMeta={(patch) => onMeta((old) => ({ ...old, ...patch }))}
    />
  )
}
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
it('changes offered modes with the node model, swaps frames and submits the node draft', async () => {
  await act(async () => root.render(<Fixture />))
  const mode = host.querySelector('select')!
  expect([...mode.options].map((option) => option.value)).toEqual(['text', 'first'])
  expect(mode.value).toBe('first')
  await act(async () =>
    [...host.querySelectorAll('button')].find((one) => one.textContent === 'Change model')!.click(),
  )
  expect([...mode.options].map((option) => option.value)).toEqual(['text', 'first', 'frames'])
  await act(async () => {
    mode.value = 'frames'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => button('对调首尾帧').click())
  await act(async () => button('生成').click())
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({ model: frames }),
    expect.any(Array),
    { two: 'first', one: 'last' },
    expect.any(Object),
  )
})
it('uploads into the explicit first-frame slot and submits that media', async () => {
  await act(async () => root.render(<Fixture />))
  await act(async () => button('首帧').click())
  const upload = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('上传'),
  )!
  await act(async () => upload.click())
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  await act(async () => {
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'frame.png', { type: 'image/png' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.querySelector('img')?.alt).toBe('frame.png')
  await act(async () => button('生成').click())
  const call = mocks.send.mock.calls[0]!
  const id = Object.keys(call[2])[0]!
  expect(call[2][id]).toBe('first')
  expect(call[3][id]).toBe('data:image/png;base64,upload')
})

it('does not inherit global voices or their quality limit for a saved silent node', async () => {
  mocks.voices = ['voice-test']
  try {
    await act(async () =>
      root.render(
        <Fixture
          initial={{
            nodeVideoMode: 'text',
            nodeVideoDraft: JSON.stringify({
              model: 'grok-imagine-video',
              duration: 5,
              aspectRatio: '16:9',
              resolution: '1080p',
            }),
          }}
        />,
      ),
    )
    expect(host.querySelector('[data-quality]')?.getAttribute('data-quality')).toBe('1080p')
    await act(async () => button('生成').click())
    expect(mocks.send.mock.calls[0]![0].voices).toBeUndefined()
  } finally {
    mocks.voices = []
  }
})

it('closes the frame menu when handing selection to the canvas', async () => {
  const pick = vi.fn()
  await act(async () => root.render(<Fixture onPickReference={pick} />))
  await act(async () => button('首帧').click())
  const choose = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('从画布选择'),
  )!
  await act(async () => choose.click())
  expect(pick).toHaveBeenCalledWith('first')
  expect(document.body.contains(choose)).toBe(false)
  expect(button('首帧').getAttribute('aria-expanded')).toBe('false')
})
