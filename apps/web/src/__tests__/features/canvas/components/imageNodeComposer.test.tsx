// @vitest-environment jsdom
import { IMAGE_PRESETS } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ImageNodeComposer from '../../../../features/canvas/components/ImageNodeComposer'
import { stubPointerApis } from '../../../helpers/radix'

const mocks = vi.hoisted(() => ({ guard: vi.fn(), upload: vi.fn(), toast: vi.fn() }))
vi.mock('../../../../components/ParamControls', () => ({ default: () => null }))
vi.mock('../../../../features/canvas/components/NodeComposerFrame', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../../../../features/canvas/components/NodeMediaImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))
vi.mock('../../../../features/canvas/lib/importImages', () => ({ fileToDataUrl: mocks.upload }))
vi.mock('../../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({ source: 'builtin-edge' }),
  clientProfileToApiProfile: () => ({ model: 'image-model' }),
}))
vi.mock('../../../../lib/privateOverlay', () => ({ usePrivateSubmissionGuard: mocks.guard }))
vi.mock('../../../../store', () => {
  const state = { settings: {}, params: { n: 3 }, showToast: mocks.toast }
  return {
    useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  }
})
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  mocks.guard.mockReturnValue({ blocked: false, estimatedCredits: 30 })
  mocks.upload.mockResolvedValue('data:image/png;base64,temporary')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
it('shows the preset badge and estimates one sheet without inheriting the global batch count', async () => {
  const remove = vi.fn()
  const send = vi.fn()
  await act(async () =>
    root.render(
      <ImageNodeComposer
        document={{}}
        nodeId="preset-image"
        references={[]}
        files={{}}
        value=""
        busy={false}
        preset={IMAGE_PRESETS[0]}
        onRemovePreset={remove}
        onChange={() => {}}
        onSubmit={send}
      />,
    ),
  )
  expect(host.textContent).toContain('人物三视图')
  expect(host.textContent).toContain('1 张拼图')
  expect(mocks.guard).toHaveBeenCalledWith({ model: 'image-model', quantity: 1 })
  expect(send).not.toHaveBeenCalled()
  await act(async () => button('移除预设').click())
  expect(remove).toHaveBeenCalledOnce()
})
it('submits temporary references without replacing the node and removes them independently', async () => {
  const send = vi.fn()
  await act(async () =>
    root.render(
      <ImageNodeComposer
        document={{}}
        nodeId="image"
        references={[]}
        files={{}}
        value=""
        busy={false}
        onChange={() => {}}
        onSubmit={send}
      />,
    ),
  )
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  expect(mocks.guard).toHaveBeenCalledWith({ model: 'image-model', quantity: 3 })
  expect(button('生成').disabled).toBe(true)
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], 'reference.png', { type: 'image/png' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.querySelector('img')?.alt).toBe('reference.png')
  expect(button('生成').disabled).toBe(false)
  await act(async () => button('生成').click())
  expect(send).toHaveBeenCalledWith(['data:image/png;base64,temporary'])
  await act(async () => button('移除引用').click())
  expect(host.querySelector('img')).toBeNull()
  expect(button('生成').disabled).toBe(true)
})
it('prevents sending before an in-flight reference upload finishes', async () => {
  let finish: (url: string) => void = () => {}
  mocks.upload.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve
    }),
  )
  const send = vi.fn()
  await act(async () =>
    root.render(
      <ImageNodeComposer
        document={{}}
        nodeId="image"
        references={[]}
        files={{}}
        value="prompt"
        busy={false}
        onChange={() => {}}
        onSubmit={send}
      />,
    ),
  )
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  await act(async () => {
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'reference.png', { type: 'image/png' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('生成').disabled).toBe(true)
  await act(async () => finish('data:image/png;base64,done'))
  expect(button('生成').disabled).toBe(false)
})

it('retains an uploading reference when switching away from its node', async () => {
  const documentScope = {}
  let finish: (url: string) => void = () => {}
  mocks.upload.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve
    }),
  )
  const composer = (
    <ImageNodeComposer
      document={documentScope}
      nodeId="image"
      references={[]}
      files={{}}
      value=""
      busy={false}
      onChange={() => {}}
      onSubmit={() => {}}
    />
  )
  await act(async () => root.render(composer))
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  await act(async () => {
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'reference.png', { type: 'image/png' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => root.render(null))
  await act(async () => finish('data:image/png;base64,done'))
  await act(async () => root.render(composer))
  expect(host.querySelector('img')?.alt).toBe('reference.png')
  expect(button('生成').disabled).toBe(false)
})
