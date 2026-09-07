// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoCard from '../../../../features/video/components/VideoCard'
import { useVideoStore } from '../../../../features/video/store'
import type { VideoTask } from '../../../../features/video/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { useStore } from '../../../../store'
import { videoTask } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_800_000_000_000

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('indexedDB', new IDBFactory())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com' } })
  useStore.setState({ showToast: vi.fn() })
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
  vi.useRealTimers()
  vi.clearAllMocks()
})

function render(task: VideoTask) {
  act(() => root.render(<VideoCard task={task} onOpen={vi.fn()} />))
}

function button(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
}

describe('a card still generating', () => {
  it('reads the elapsed time next to what this model usually takes', () => {
    render(videoTask({ status: 'running', createdAt: NOW - 12_000, completedAt: null }))

    expect(host.textContent).toContain('12s')
    expect(host.textContent).toContain('生成中')
    expect(host.textContent).toContain('通常 40 秒')
  })

  it('fills the progress bar against the typical run', () => {
    render(videoTask({ status: 'running', createdAt: NOW - 20_000, completedAt: null }))

    const bar = host.querySelector<HTMLElement>('.bg-blue-500')

    expect(bar?.style.width).toBe('50%')
  })

  it('says queued before the upstream picks it up', () => {
    render(videoTask({ status: 'queued', completedAt: null }))

    expect(host.textContent).toContain('排队')
    expect(host.textContent).not.toContain('生成中')
  })
})

describe('a finished card', () => {
  it('badges the duration and the frame source', () => {
    render(videoTask({ source: 'image', firstFrameImageId: 'a', lastFrameImageId: 'b' }))

    expect(host.textContent).toContain('0:05')
    expect(host.textContent).toContain('首帧 · 尾帧')
  })

  it('reads model, duration, ratio and credits', () => {
    render(videoTask({ credits: 300 }))

    expect(host.textContent).toContain('Grok')
    expect(host.textContent).toContain('5 秒')
    expect(host.textContent).toContain('16:9')
    expect(host.textContent).toContain('300 积分')
  })

  it('offers the hover actions', () => {
    render(videoTask())

    expect(button('下载')).toBeDefined()
    expect(button('重生成')).toBeDefined()
    expect(button('用作首帧')).toBeDefined()
  })
})

describe('a failed card', () => {
  it('writes the reason, the refund and a retry', () => {
    render(videoTask({ status: 'error', error: '上游未返回视频', credits: 400 }))

    expect(host.textContent).toContain('失败')
    expect(host.textContent).toContain('上游未返回视频')
    expect(host.textContent).toContain('已退 400 积分')
    expect(button('重试')).toBeDefined()
  })

  it('drops the play and download affordances', () => {
    render(videoTask({ status: 'error', error: '上游未返回视频' }))

    expect(button('下载')).toBeUndefined()
  })
})

describe('a text-to-video card without a thumbnail', () => {
  it('grabs the first frame off the player once data arrives', () => {
    const setThumbnail = vi.fn(async () => {})
    useVideoStore.setState({ setThumbnail })
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
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,x')
    render(videoTask())

    const probe = host.querySelector('[data-video-thumbnail-probe]')
    expect(probe?.getAttribute('src')).toBe(
      'https://bff.example.com/v1/queue/requests/req-1/output/0',
    )

    act(() => probe?.dispatchEvent(new Event('loadeddata', { bubbles: true })))

    expect(setThumbnail).toHaveBeenCalledWith('task-1', 'data:image/jpeg;base64,x')
  })

  it('does not mount the probe once a thumbnail exists', () => {
    render(videoTask({ thumbnailDataUrl: 'data:image/png;base64,y' }))

    expect(host.querySelector('[data-video-thumbnail-probe]')).toBeNull()
  })
})
