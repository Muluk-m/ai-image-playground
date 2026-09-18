import type { AgentToolArtifact } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { placedArtifact } from '../../../../features/agent/lib/artifactDelivery'

const POSTER = 'data:image/png;base64,UE9T'

function artifact(extra: Partial<AgentToolArtifact> = {}): AgentToolArtifact {
  return {
    artifactId: 'a1',
    media: 'video',
    taskId: 't1',
    outputIndex: 2,
    mime: 'video/mp4',
    ...extra,
  }
}

describe('智能体产物到画布对象', () => {
  it('carries what the video was generated with onto the canvas object', () => {
    const generation = {
      model: 'grok-imagine-video',
      duration: 6,
      aspectRatio: '9:16',
      resolution: '720p',
    } as const
    expect(placedArtifact(artifact({ video: generation }), POSTER)).toEqual({
      artifactId: 'a1',
      dataUrl: POSTER,
      video: { taskId: 't1', outputIndex: 2, generation },
    })
  })

  it('keeps older video records playable without parameters', () => {
    expect(placedArtifact(artifact(), POSTER).video).toEqual({ taskId: 't1', outputIndex: 2 })
  })

  it('drops a malformed record instead of writing it into the canvas', () => {
    const broken = { model: '', duration: 6 } as unknown as AgentToolArtifact['video']
    expect(placedArtifact(artifact({ video: broken }), POSTER).video).toEqual({
      taskId: 't1',
      outputIndex: 2,
    })
  })

  it('places images without a video source', () => {
    expect(placedArtifact(artifact({ media: 'image', mime: 'image/png' }), POSTER)).toEqual({
      artifactId: 'a1',
      dataUrl: POSTER,
    })
  })
})
