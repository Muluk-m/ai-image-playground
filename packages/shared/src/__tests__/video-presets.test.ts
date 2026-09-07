import { describe, expect, it } from 'bun:test'
import {
  VIDEO_MODEL_SUPPORT,
  type VideoRequest,
  validateVideoRequest,
  videoRateMultiplier,
} from '../video-presets'

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5'

function request(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p', ...overrides }
}

describe('validateVideoRequest', () => {
  it('accepts a legal text-to-video combination on both models', () => {
    expect(validateVideoRequest(GROK, request({ duration_seconds: 10 }), 0)).toEqual({ ok: true })
    expect(validateVideoRequest(AGNES, request({ aspect_ratio: '9:16' }), 0)).toEqual({ ok: true })
  })

  it('accepts a first frame on Grok and both keyframes on Agnes', () => {
    expect(validateVideoRequest(GROK, request({ first_frame_index: 0 }), 1)).toEqual({ ok: true })
    expect(
      validateVideoRequest(AGNES, request({ first_frame_index: 0, last_frame_index: 1 }), 2),
    ).toEqual({ ok: true })
  })

  it('rejects a last frame on Grok', () => {
    expect(validateVideoRequest(GROK, request({ last_frame_index: 0 }), 1)).toEqual({
      ok: false,
      reason: 'Grok 不支持尾帧',
    })
  })

  it('accepts 2k on Agnes and rejects it on Grok', () => {
    expect(validateVideoRequest(AGNES, request({ resolution: '2k' }), 0)).toEqual({ ok: true })
    expect(validateVideoRequest(GROK, request({ resolution: '2k' }), 0)).toEqual({
      ok: false,
      reason: 'Grok 清晰度只支持 720p / 1080p',
    })
  })

  it('names 2K in the Agnes resolution reason', () => {
    const result = validateVideoRequest(AGNES, request({ resolution: '4k' as never }), 0)
    expect(result).toEqual({
      ok: false,
      reason: 'Agnes 2.5 清晰度只支持 720p / 1080p / 2K',
    })
  })

  it('rejects an out-of-range first_frame_index', () => {
    expect(validateVideoRequest(GROK, request({ first_frame_index: 1 }), 1)).toEqual({
      ok: false,
      reason: '首帧图片不存在',
    })
    expect(validateVideoRequest(GROK, request({ first_frame_index: -1 }), 1)).toEqual({
      ok: false,
      reason: '首帧图片不存在',
    })
    expect(validateVideoRequest(AGNES, request({ last_frame_index: 2 }), 2)).toEqual({
      ok: false,
      reason: '尾帧图片不存在',
    })
  })

  it('rejects an unsupported duration', () => {
    expect(validateVideoRequest(GROK, request({ duration_seconds: 12 as never }), 0)).toEqual({
      ok: false,
      reason: 'Grok 时长只支持 5 / 8 / 10 秒',
    })
  })

  it('rejects an unsupported aspect ratio', () => {
    expect(validateVideoRequest(AGNES, request({ aspect_ratio: '4:3' as never }), 0)).toEqual({
      ok: false,
      reason: 'Agnes 2.5 画幅只支持 16:9 / 9:16 / 1:1',
    })
  })

  it('rejects a model that is not a video model', () => {
    expect(validateVideoRequest('gpt-image-2', request(), 0)).toEqual({
      ok: false,
      reason: '该模型不支持视频生成',
    })
  })
})

describe('videoRateMultiplier', () => {
  it('returns the per-resolution multiplier', () => {
    expect(videoRateMultiplier('720p')).toBe(1)
    expect(videoRateMultiplier('1080p')).toBe(1.6)
    expect(videoRateMultiplier('2k')).toBe(2.2)
  })
})

describe('VIDEO_MODEL_SUPPORT', () => {
  it('carries the typical elapsed seconds shown while generating', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK].typicalSeconds).toBe(40)
    expect(VIDEO_MODEL_SUPPORT[AGNES].typicalSeconds).toBe(90)
  })
})
