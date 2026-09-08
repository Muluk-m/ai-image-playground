// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoLightbox from '../../../../features/video/components/VideoLightbox'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../../features/video/store'
import type { VideoTask } from '../../../../features/video/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { useStore } from '../../../../store'
import { videoTask } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CAPTURED_FRAME = 'data:image/jpeg;base64,captured'

const storeImageFromUrl = vi.hoisted(() =>
  vi.fn(async (dataUrl: string) => ({ id: 'frame-1', dataUrl })),
)

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  storeImageFromUrl,
}))

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com/' } })
  useStore.setState({ showToast: vi.fn() })
  useVideoStore.setState({ tasks: [], draft: { ...INITIAL_VIDEO_DRAFT } })

  // jsdom 的 video 没有解码帧，canvas 也没有 2d 上下文：两端都换成可断言的替身。
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    value: 1280,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    value: 720,
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(CAPTURED_FRAME)

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function render(task: VideoTask = videoTask()) {
  act(() => root.render(<VideoLightbox task={task} onClose={onClose} />))
}

function player(): HTMLVideoElement {
  const video = document.querySelector('video')
  if (!video) throw new Error('no player')
  return video
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

async function click(text: string) {
  await act(async () => {
    button(text).click()
  })
}

describe('playing a finished video', () => {
  it('points the player at the queue output endpoint with credentials', () => {
    render()

    expect(player().getAttribute('src')).toBe(
      'https://bff.example.com/v1/queue/requests/req-1/output/0',
    )
    expect(player().getAttribute('crossorigin')).toBe('use-credentials')
  })

  it('reads the parameters, credits and timing', () => {
    render(videoTask({ credits: 300, aspectRatio: '9:16', resolution: '1080p' }))

    expect(document.body.textContent).toContain('5 秒 · 9:16 · 1080p')
    expect(document.body.textContent).toContain('300')
    expect(document.body.textContent).toContain('用时 39 秒')
  })

  it('reads the actual output size for an image source', () => {
    render(videoTask({ source: 'image', firstFrameImageId: 'a', width: 960, height: 960 }))

    expect(document.body.textContent).toContain('5 秒 · 960\u00d7960 · 720p')
  })

  it('reads 随首帧 for an image source without a size', () => {
    render(videoTask({ source: 'image', firstFrameImageId: 'a' }))

    expect(document.body.textContent).toContain('5 秒 · 随首帧 · 720p')
  })
})

describe('acting on a video', () => {
  it('copies the description', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render()

    await click('霓虹街道跑车驶过')

    expect(writeText).toHaveBeenCalledWith('霓虹街道跑车驶过')
  })

  it('sends the current frame back to the first frame slot', async () => {
    render()

    await click('用作首帧')

    expect(storeImageFromUrl).toHaveBeenCalledWith(CAPTURED_FRAME)
    expect(useVideoStore.getState().draft).toMatchObject({
      source: 'image',
      firstFrameImageId: 'frame-1',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('loads the same parameters back into the composer without submitting', async () => {
    render(videoTask({ prompt: '沙漠日出', duration: 10, aspectRatio: '9:16' }))

    await click('相同参数再来一条')

    expect(useVideoStore.getState().draft).toMatchObject({
      prompt: '沙漠日出',
      duration: 10,
      aspectRatio: '9:16',
    })
    expect(useVideoStore.getState().tasks).toEqual([])
  })

  it('drops the record on delete', async () => {
    const removeTask = vi.fn(async () => {})
    useVideoStore.setState({ removeTask })
    render()

    await click('删除')

    expect(removeTask).toHaveBeenCalledWith('task-1')
    expect(onClose).toHaveBeenCalled()
  })
})
