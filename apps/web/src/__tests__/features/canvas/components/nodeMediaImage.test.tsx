// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NodePicture } from '../../../../features/canvas/components/NodeMediaImage'

const resolveMediaSource = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/cloudMedia', () => ({
  mediaIdentity: (source?: string) => source?.match(/^aip-media:([0-9a-f-]{36})$/i)?.[1],
  resolveMediaSource: (...args: unknown[]) => resolveMediaSource(...args),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CLOUD = 'aip-media:11111111-1111-4111-8111-111111111111'
const OTHER = 'aip-media:22222222-2222-4222-8222-222222222222'
const LOCAL = 'data:image/png;base64,local'

let host: HTMLDivElement
let root: Root

function picture(source: string | undefined, identity: string) {
  return (
    <NodePicture
      source={source}
      identity={identity}
      uploading={false}
      missingLabel="素材缺失"
      uploadingLabel="图片上传中"
    />
  )
}

beforeEach(() => {
  resolveMediaSource.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('keeps the image when the same picture switches from a local address to cloud media', async () => {
  resolveMediaSource.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(picture(LOCAL, 'same')))
  const image = host.querySelector('img')
  expect(image?.getAttribute('src')).toBe(LOCAL)
  expect(host.textContent).not.toContain('素材缺失')

  await act(async () => root.render(picture(CLOUD, 'same')))
  expect(host.querySelector('img')).toBe(image)
  expect(image?.getAttribute('src')).toBe(LOCAL)
  expect(host.textContent).not.toContain('素材缺失')
  expect(host.querySelector('[data-testid="node-media-loading"]')).toBeNull()
})

it('shows media missing only after cloud preview retries are exhausted', async () => {
  resolveMediaSource.mockRejectedValue(new Error('offline'))
  await act(async () => root.render(picture(CLOUD, 'same')))
  expect(host.textContent).not.toContain('素材缺失')
  expect(host.querySelector('[data-testid="node-media-loading"]')).not.toBeNull()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(host.textContent).not.toContain('素材缺失')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000)
  })
  expect(host.textContent).toContain('素材缺失')
  expect(host.querySelector('img')).toBeNull()
})

it('does not keep the previous cloud picture when another cloud image is still loading', async () => {
  let release: (url: string) => void = () => {}
  resolveMediaSource.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      }),
  )
  await act(async () => root.render(picture(CLOUD, 'same')))
  await act(async () => release('blob:first'))
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:first')

  resolveMediaSource.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(picture(OTHER, 'same')))
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).not.toContain('素材缺失')
  expect(host.querySelector('[data-testid="node-media-loading"]')).not.toBeNull()
})

it('does not keep the previous picture when the identity changes', async () => {
  resolveMediaSource.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(picture(LOCAL, 'first')))
  await act(async () => root.render(picture(OTHER, 'second')))
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).not.toContain('素材缺失')
  expect(host.querySelector('[data-testid="node-media-loading"]')).not.toBeNull()
})
