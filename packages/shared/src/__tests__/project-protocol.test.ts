import { describe, expect, it } from 'bun:test'
import { isProjectDocument } from '../project-protocol'

const MEDIA = '0f8b6a4e-2c1d-4e5f-9a7b-3c2d1e0f9a8b'

function withVideo(video: unknown) {
  return {
    version: 1,
    elements: [
      {
        id: 'clip',
        type: 'image',
        mediaId: MEDIA,
        x: 0,
        y: 0,
        width: 360,
        height: 640,
        rotation: 0,
        video,
      },
    ],
  }
}

const GENERATION = {
  model: 'doubao-seedance-2-0-mini-260615',
  duration: 8,
  aspectRatio: '9:16',
  resolution: '720p',
  firstFrameId: 'frame',
}

describe('云端项目文档里的视频', () => {
  it('accepts a video poster with its playback source and generation record', () => {
    expect(isProjectDocument(withVideo({ taskId: 'task-1', outputIndex: 0 }))).toBe(true)
    expect(
      isProjectDocument(withVideo({ taskId: 'task-1', outputIndex: 0, generation: GENERATION })),
    ).toBe(true)
  })

  it('rejects a playback source it could not build a URL from', () => {
    expect(isProjectDocument(withVideo({ taskId: '', outputIndex: 0 }))).toBe(false)
    expect(isProjectDocument(withVideo({ taskId: 'a/b', outputIndex: 0 }))).toBe(false)
    expect(isProjectDocument(withVideo({ taskId: 'task-1', outputIndex: -1 }))).toBe(false)
    expect(isProjectDocument(withVideo({ taskId: 'task-1', outputIndex: 1.5 }))).toBe(false)
    expect(isProjectDocument(withVideo({ taskId: 'task-1' }))).toBe(false)
    expect(isProjectDocument(withVideo({ taskId: 'task-1', outputIndex: 0, url: 'x' }))).toBe(false)
  })

  it('rejects a malformed generation record', () => {
    expect(
      isProjectDocument(
        withVideo({ taskId: 'task-1', outputIndex: 0, generation: { ...GENERATION, duration: 0 } }),
      ),
    ).toBe(false)
  })
})

function withTimeline(clips: unknown) {
  return {
    version: 1,
    elements: [{ id: 'tl', type: 'timeline', x: 0, y: 0, width: 400, height: 120, clips }],
  }
}

describe('云端项目文档里的时间线', () => {
  it('accepts ordered clip references with in and optional out points', () => {
    expect(
      isProjectDocument(
        withTimeline([
          { elementId: 'clip-a', in: 0 },
          { elementId: 'clip-b', in: 0.5, out: 6 },
        ]),
      ),
    ).toBe(true)
    expect(isProjectDocument(withTimeline([]))).toBe(true)
  })

  it('rejects clips that could not be played back', () => {
    expect(isProjectDocument(withTimeline([{ elementId: '', in: 0 }]))).toBe(false)
    expect(isProjectDocument(withTimeline([{ elementId: 'a', in: -1 }]))).toBe(false)
    expect(isProjectDocument(withTimeline([{ elementId: 'a', in: 3, out: 3 }]))).toBe(false)
    expect(isProjectDocument(withTimeline([{ elementId: 'a', in: 0, url: 'x' }]))).toBe(false)
    expect(isProjectDocument(withTimeline('a'))).toBe(false)
    expect(
      isProjectDocument(
        withTimeline(Array.from({ length: 65 }, () => ({ elementId: 'a', in: 0 }))),
      ),
    ).toBe(false)
  })
})

function withGeneration(extra: Record<string, unknown>) {
  const generationId = 'task-1'
  return {
    version: 1,
    elements: [
      {
        id: `agent_${generationId}_0`,
        type: 'generation',
        generationId,
        position: 0,
        x: 0,
        y: 0,
        width: 360,
        height: 360,
        ...extra,
      },
    ],
  }
}

describe('云端项目文档里的失败占位', () => {
  it('keeps a failed generation reservation together with its error code', () => {
    expect(isProjectDocument(withGeneration({}))).toBe(true)
    expect(isProjectDocument(withGeneration({ errorCode: 'timeout' }))).toBe(true)
    expect(isProjectDocument(withGeneration({ errorCode: 'insufficient_credits' }))).toBe(true)
  })

  it('rejects an error code the protocol does not know', () => {
    expect(isProjectDocument(withGeneration({ errorCode: 'boom' }))).toBe(false)
    expect(isProjectDocument(withGeneration({ errorCode: '' }))).toBe(false)
    expect(isProjectDocument(withGeneration({ status: 'failed' }))).toBe(false)
  })
})
