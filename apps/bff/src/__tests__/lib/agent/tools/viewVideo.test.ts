import { afterEach, expect, it } from 'bun:test'
import type { AgentCanvasSnapshot } from '@image-playground/shared'
import sharp from 'sharp'
import type { AgentToolContext } from '../../../../lib/agent/tools/types'

process.env.DATABASE_URL = 'postgres://unused/agent-view-video'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.LOG_LEVEL = 'silent'

const { viewVideo } = await import('../../../../lib/agent/tools/viewVideo')
const { readCanvas } = await import('../../../../lib/agent/tools/readCanvas')
const { readVideoClip, setVideoClipReaderForTesting } = await import(
  '../../../../lib/agent/video-clip'
)
const { setVideoSamplerForTesting, VideoUnreadable } = await import(
  '../../../../lib/agent/video-frames'
)

const JPEG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: '#336699' },
})
  .jpeg()
  .toBuffer()

function context(canvas?: AgentCanvasSnapshot): AgentToolContext {
  return {
    mode: 'video',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: 'user-1',
    deviceId: 'device-abcdefgh',
    images: { identify: (id: string) => id } as AgentToolContext['images'],
    ...(canvas ? { canvas } : {}),
  }
}

afterEach(() => {
  setVideoClipReaderForTesting(null)
  setVideoSamplerForTesting(null)
})

it('titles the step 看视频 and hands over timestamped stills', async () => {
  expect(viewVideo.call({ videoId: 'agent_task-1_0' }, 'video').title).toBe('看视频')
  setVideoClipReaderForTesting(async () => ({
    ok: true,
    videoId: 'agent_task-1_0',
    bytes: new Uint8Array([1]),
    mime: 'video/mp4',
    durationSeconds: 2,
  }))
  setVideoSamplerForTesting(async () => ({
    durationSeconds: 2,
    intervalSeconds: 1,
    frames: [
      { timeSeconds: 0, jpeg: JPEG },
      { timeSeconds: 1, jpeg: JPEG },
    ],
  }))

  const result = await viewVideo
    .create(context())
    .execute('call-1', { videoId: 'agent_task-1_0' }, undefined, undefined)
  const text = result.content[0]
  expect(text).toMatchObject({ type: 'text' })
  if (text?.type !== 'text') return
  expect(text.text).toContain('t=0s、t=1s')
  expect(text.text).toContain('大约每秒 1 帧')
  expect(text.text).toContain('静帧')
  expect(text.text).toContain('没有听到音轨')
  expect(text.text).toContain('图片 agent_task-1_0@0 缩略图')
  expect(result.content.filter((block) => block.type === 'image')).toHaveLength(2)
})

it('returns the reader message when the id is not a finished video', async () => {
  setVideoClipReaderForTesting(async () => ({ ok: false, message: '找不到这段视频。' }))
  const result = await viewVideo
    .create(context())
    .execute('call-1', { videoId: 'agent_missing_0' }, undefined, undefined)
  expect(result.content).toEqual([{ type: 'text', text: '找不到这段视频。' }])
})

it('tells the model a cover id is not a video, without reading the database', async () => {
  const cover = await readVideoClip(context(), '11111111-2222-4333-8444-555555555555')
  expect(cover).toEqual({ ok: false, message: '这是封面图片 id，看视频请用视频 id。' })
  const named = await readVideoClip(context(), 'aip-media:11111111-2222-4333-8444-555555555555')
  expect(named.ok).toBe(false)
  const other = await readVideoClip(context(), 'image 1')
  expect(other).toEqual({
    ok: false,
    message: '这不是视频 id。看视频请用结果里的视频 id。',
  })
})

it('lets a cancelled read leave the tool and free the preparation slot', async () => {
  const controller = new AbortController()
  let entered: (signal?: AbortSignal) => void = () => {}
  const started = new Promise<AbortSignal | undefined>((resolve) => {
    entered = resolve
  })
  setVideoClipReaderForTesting((_context, _videoId, signal) => {
    entered(signal)
    return new Promise((_resolve, reject) => {
      if (!signal) {
        reject(new Error('missing signal'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const pending = viewVideo
    .create(context())
    .execute('call-1', { videoId: 'agent_task-1_0' }, controller.signal, undefined)
  expect(await started).toBe(controller.signal)
  controller.abort()
  await expect(pending).rejects.toBeInstanceOf(DOMException)

  setVideoClipReaderForTesting(async () => ({ ok: false, message: '找不到这段视频。' }))
  const next = await viewVideo
    .create(context())
    .execute('call-2', { videoId: 'agent_task-1_0' }, undefined, undefined)
  expect(next.content).toEqual([{ type: 'text', text: '找不到这段视频。' }])
})

it('says the stills are unavailable when sampling fails', async () => {
  setVideoClipReaderForTesting(async () => ({
    ok: true,
    videoId: 'agent_task-1_0',
    bytes: new Uint8Array([1]),
    mime: 'video/mp4',
  }))
  setVideoSamplerForTesting(async () => {
    throw new VideoUnreadable()
  })
  const result = await viewVideo
    .create(context())
    .execute('call-1', { videoId: 'agent_task-1_0' }, undefined, undefined)
  expect(result.content).toEqual([{ type: 'text', text: '这段视频暂时抽不出画面，请稍后再试。' }])
})

it('points a canvas video at viewVideo and its artifact id', async () => {
  const canvas: AgentCanvasSnapshot = {
    elements: [
      {
        id: 'el-1',
        type: 'image',
        x: 0,
        y: 0,
        width: 90,
        height: 160,
        video: true,
        videoId: 'agent_task-1_0',
        mediaId: '11111111-2222-4333-8444-555555555555',
      },
      {
        id: 'el-2',
        type: 'image',
        x: 10,
        y: 10,
        width: 90,
        height: 160,
        video: true,
      },
    ],
  }
  const result = await readCanvas
    .create(context(canvas))
    .execute('call-2', {}, undefined, undefined)
  const text = result.content[0]
  expect(text).toMatchObject({ type: 'text' })
  if (text?.type !== 'text') return
  expect(text.text).toContain('视频 id agent_task-1_0')
  expect(text.text).toContain('用 viewVideo 看画面')
  expect(text.text).toContain('封面图片 id 11111111-2222-4333-8444-555555555555 只是第一帧')
  expect(text.text).toContain('目录里没有视频 id，看不了成片画面')
})
