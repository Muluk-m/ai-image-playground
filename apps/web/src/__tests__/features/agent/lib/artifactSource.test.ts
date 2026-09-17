// @vitest-environment jsdom
import type { AgentToolArtifact } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BLANK = 'data:image/png;base64,BLANK'
const FRAME = 'data:image/png;base64,FRAME'
const capture = vi.hoisted(() =>
  vi.fn(async (_url: string): Promise<string | null> => 'data:image/png;base64,FRAME'),
)

vi.mock('../../../../features/agent/lib/videoPoster', () => ({
  captureVideoPoster: (url: string) => capture(url),
  blankVideoPoster: () => BLANK,
}))

import {
  artifactBitmap,
  previewArtifactBitmap,
  videoOutputFrame,
} from '../../../../features/agent/lib/artifactSource'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

/** 缓存是模块级的，所以每个用例用自己的 id，互不借光。 */
let seq = 0
function make(
  media: 'image' | 'video',
  overrides: Partial<AgentToolArtifact> = {},
): AgentToolArtifact {
  const id = `${media}-${++seq}`
  return {
    artifactId: `agent_${id}`,
    media,
    taskId: `task-${id}`,
    outputIndex: 0,
    mime: media === 'video' ? 'video/mp4' : 'image/png',
    ...overrides,
  }
}
const image = (overrides?: Partial<AgentToolArtifact>) => make('image', overrides)
const video = (overrides?: Partial<AgentToolArtifact>) => make('video', overrides)

let imageResponse: () => Response | Promise<Response>
const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input)
  if (url.includes('/image/')) return imageResponse()
  throw new Error(`unexpected request ${url}`)
})

function imageUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input))
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  capture.mockClear()
  capture.mockImplementation(async () => FRAME)
  imageResponse = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
})

afterEach(() => vi.unstubAllGlobals())

describe('介质判别', () => {
  it('图片产物取原图，不碰视频地址', async () => {
    const artifact = image()
    await expect(artifactBitmap(artifact)).resolves.toMatch(/^data:image\/png;base64,/)
    expect(imageUrls()).toEqual([`http://bff.test/v1/queue/requests/${artifact.taskId}/image/0`])
    expect(capture).not.toHaveBeenCalled()
  })

  it('视频产物取封面，mp4 不下载到本地', async () => {
    const artifact = video({ outputIndex: 2 })
    await expect(artifactBitmap(artifact)).resolves.toBe(FRAME)
    expect(capture).toHaveBeenCalledWith(
      `http://bff.test/v1/queue/requests/${artifact.taskId}/output/2`,
    )
    expect(imageUrls()).toEqual([])
  })

  it('首帧抓不到时给深色底，画布上仍有一张点得开的图', async () => {
    capture.mockImplementation(async () => null)
    await expect(artifactBitmap(video())).resolves.toBe(BLANK)
  })

  it('图片取不到就抛，交付据此记失败', async () => {
    imageResponse = () => new Response('nope', { status: 500 })
    await expect(artifactBitmap(image())).rejects.toThrow()
  })
})

describe('缓存', () => {
  it('同一件产物并发与重复请求只取一次', async () => {
    const artifact = image()
    const [first, second] = await Promise.all([
      previewArtifactBitmap(artifact),
      previewArtifactBitmap(artifact),
    ])
    expect(second).toBe(first)
    await expect(previewArtifactBitmap(artifact)).resolves.toBe(first)
    expect(imageUrls()).toHaveLength(1)
  })

  it('取不到的不进缓存，下次还能再试', async () => {
    const artifact = image()
    imageResponse = () => new Response('nope', { status: 500 })
    await expect(previewArtifactBitmap(artifact)).resolves.toBeNull()
    imageResponse = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    await expect(previewArtifactBitmap(artifact)).resolves.toMatch(/^data:image\/png;base64,/)
    expect(imageUrls()).toHaveLength(2)
  })

  it('抓不到的首帧不占着位置，下次重抓', async () => {
    const artifact = video()
    capture.mockImplementation(async () => null)
    await expect(videoOutputFrame(artifact)).resolves.toBeNull()
    capture.mockImplementation(async () => FRAME)
    await expect(videoOutputFrame(artifact)).resolves.toBe(FRAME)
    await expect(videoOutputFrame(artifact)).resolves.toBe(FRAME)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('存到上限就淘汰最早那件，它下次要重取', async () => {
    const first = image()
    await previewArtifactBitmap(first)
    const rest = Array.from({ length: 12 }, () => image())
    for (const artifact of rest) await previewArtifactBitmap(artifact)
    fetchMock.mockClear()
    await previewArtifactBitmap(rest[rest.length - 1]!)
    expect(imageUrls()).toEqual([])
    await previewArtifactBitmap(first)
    expect(imageUrls()).toHaveLength(1)
  })
})
