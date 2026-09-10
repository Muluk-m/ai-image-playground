// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadProgressLabel,
  downloadVideoTask,
  videoFileName,
  videoOutputUrl,
} from '../../../../features/video/lib/playback'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { videoTask } from '../fixtures'

const authenticatedBffFetch = vi.hoisted(() => vi.fn())
const downloadBlob = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch }))
vi.mock('../../../../lib/downloadImages', () => ({ downloadBlob }))

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com/' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('addressing a video output', () => {
  it('builds the queue output endpoint', () => {
    expect(videoOutputUrl(videoTask({ bffRequestId: 'req-9', outputIndex: 2 }))).toBe(
      'https://bff.example.com/v1/queue/requests/req-9/output/2',
    )
  })

  it('has no address before the task completes', () => {
    expect(videoOutputUrl(videoTask({ bffRequestId: undefined }))).toBeNull()
  })
})

describe('naming the downloaded file', () => {
  it('carries the first 20 characters of the description and the duration', () => {
    const task = videoTask({
      prompt: '浴缸注水，水面轻微波动，镜头缓慢推进，柔和的侧窗日光',
      duration: 10,
    })

    expect(videoFileName(task)).toBe('浴缸注水，水面轻微波动，镜头缓慢推进，柔-10s.mp4')
  })

  it('replaces whatever a filesystem would reject', () => {
    expect(videoFileName(videoTask({ prompt: 'a/b c:d' }))).toBe('a-b-c-d-5s.mp4')
  })

  it('still names a video with an empty description', () => {
    expect(videoFileName(videoTask({ prompt: '  ' }))).toBe('video-5s.mp4')
  })
})

function streamedResponse(chunks: number[], headers: Record<string, string>) {
  const queue = chunks.map((size) => new Uint8Array(size))
  return {
    ok: true,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => {
          const value = queue.shift()
          return value ? { done: false, value } : { done: true, value: undefined }
        },
      }),
    },
  }
}

describe('labelling download progress', () => {
  it('reads a percentage once the total is known', () => {
    expect(downloadProgressLabel({ received: 5, total: 10 })).toBe('下载中 50%')
  })

  it('reads received megabytes without a total', () => {
    expect(downloadProgressLabel({ received: 3_355_443, total: null })).toBe('下载中 3.2 MB')
  })
})

describe('downloading a video', () => {
  it('fetches the output with credentials and hands the blob to the saver', async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' })
    authenticatedBffFetch.mockResolvedValue({ ok: true, blob: async () => blob })

    await downloadVideoTask(videoTask({ prompt: '霓虹街道' }))

    expect(authenticatedBffFetch).toHaveBeenCalledWith(
      'https://bff.example.com/v1/queue/requests/req-1/output/0',
      { signal: undefined },
    )
    expect(downloadBlob).toHaveBeenCalledWith(blob, '霓虹街道-5s.mp4')
  })

  it('assembles the streamed chunks into the saved file', async () => {
    authenticatedBffFetch.mockResolvedValue(
      streamedResponse([4, 6], { 'content-type': 'video/mp4' }),
    )

    await downloadVideoTask(videoTask({ prompt: '霓虹街道' }))

    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string]
    expect(blob.size).toBe(10)
    expect(blob.type).toBe('video/mp4')
    expect(filename).toBe('霓虹街道-5s.mp4')
  })

  it('reports a percentage while the response declares its length', async () => {
    authenticatedBffFetch.mockResolvedValue(streamedResponse([2, 3], { 'content-length': '10' }))
    const onProgress = vi.fn()

    await downloadVideoTask(videoTask(), { onProgress })

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { received: 0, total: 10 },
      { received: 2, total: 10 },
      { received: 5, total: 10 },
    ])
  })

  it('reports received bytes when the response declares no length', async () => {
    authenticatedBffFetch.mockResolvedValue(streamedResponse([1_048_576 * 2], {}))
    const onProgress = vi.fn()

    await downloadVideoTask(videoTask(), { onProgress })

    expect(onProgress).toHaveBeenLastCalledWith({ received: 2_097_152, total: null })
  })

  it('stays quiet across chunks that would not move the label', async () => {
    authenticatedBffFetch.mockResolvedValue(
      streamedResponse([64, 64, 64], { 'content-length': '10000000' }),
    )
    const onProgress = vi.fn()

    await downloadVideoTask(videoTask(), { onProgress })

    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('passes the caller signal so a closed view stops pulling bytes', async () => {
    const controller = new AbortController()
    authenticatedBffFetch.mockResolvedValue(streamedResponse([1], {}))

    await downloadVideoTask(videoTask(), { signal: controller.signal })

    expect(authenticatedBffFetch).toHaveBeenCalledWith(expect.any(String), {
      signal: controller.signal,
    })
  })

  it('reports an upstream refusal instead of saving an error page', async () => {
    authenticatedBffFetch.mockResolvedValue({ ok: false, status: 403 })

    await expect(downloadVideoTask(videoTask())).rejects.toThrow('403')
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
