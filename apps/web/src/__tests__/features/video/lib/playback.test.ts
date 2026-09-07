// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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

describe('downloading a video', () => {
  it('fetches the output with credentials and hands the blob to the saver', async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' })
    authenticatedBffFetch.mockResolvedValue({ ok: true, blob: async () => blob })

    await downloadVideoTask(videoTask({ prompt: '霓虹街道' }))

    expect(authenticatedBffFetch).toHaveBeenCalledWith(
      'https://bff.example.com/v1/queue/requests/req-1/output/0',
    )
    expect(downloadBlob).toHaveBeenCalledWith(blob, '霓虹街道-5s.mp4')
  })

  it('reports an upstream refusal instead of saving an error page', async () => {
    authenticatedBffFetch.mockResolvedValue({ ok: false, status: 403 })

    await expect(downloadVideoTask(videoTask())).rejects.toThrow('403')
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
