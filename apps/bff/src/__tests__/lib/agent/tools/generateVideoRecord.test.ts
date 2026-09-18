import { describe, expect, it } from 'bun:test'
import type { AgentToolArtifact } from '@image-playground/shared'

// 只测纯函数，不发 SQL；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-generate-video-record'
process.env.LOG_LEVEL = 'silent'

const { withVideoRecord } = await import('../../../../lib/agent/tools/generateVideo')

const PRESET = { duration: 6, aspectRatio: '9:16', resolution: '720p' } as const

function artifact(media: AgentToolArtifact['media']): AgentToolArtifact {
  return { artifactId: `a-${media}`, media, taskId: 't1', outputIndex: 0, mime: 'video/mp4' }
}

describe('生视频的产物记下实际提交的参数', () => {
  it('records the clamped preset and the model, not what the model asked for', () => {
    const [video] = withVideoRecord([artifact('video')], 'grok-imagine-video', PRESET, null)
    expect(video?.video).toEqual({
      model: 'grok-imagine-video',
      duration: 6,
      aspectRatio: '9:16',
      resolution: '720p',
    })
  })

  it('names the canvas object used as the first frame', () => {
    const [video] = withVideoRecord([artifact('video')], 'm', PRESET, 'el_frame')
    expect(video?.video?.firstFrameId).toBe('el_frame')
  })

  it('leaves image artifacts alone', () => {
    const [image] = withVideoRecord([artifact('image')], 'm', PRESET, null)
    expect(image?.video).toBeUndefined()
  })
})
