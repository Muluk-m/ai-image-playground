import { describe, expect, it } from 'bun:test'
import {
  VIDEO_MODEL_SUPPORT,
  type VideoRequest,
  validateVideoRequest,
  videoRateMultiplier,
} from '../video-presets'

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5-flash'

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

  it('rejects 2k on both models', () => {
    expect(validateVideoRequest(AGNES, request({ resolution: '2k' }), 0)).toEqual({
      ok: false,
      reason: 'Agnes 2.5 Flash 清晰度只支持 720p',
    })
    expect(validateVideoRequest(GROK, request({ resolution: '2k' }), 0)).toEqual({
      ok: false,
      reason: 'Grok 清晰度只支持 720p / 1080p',
    })
  })

  it('rejects 1080p on Agnes Flash, which is 720P only', () => {
    expect(validateVideoRequest(AGNES, request({ resolution: '1080p' }), 0)).toEqual({
      ok: false,
      reason: 'Agnes 2.5 Flash 清晰度只支持 720p',
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
    expect(validateVideoRequest(GROK, request({ duration_seconds: 12 }), 0)).toEqual({
      ok: false,
      reason: 'Grok 时长只支持 5 / 8 / 10 秒',
    })
  })

  it('rejects an unsupported aspect ratio', () => {
    expect(validateVideoRequest(AGNES, request({ aspect_ratio: '4:3' as never }), 0)).toEqual({
      ok: false,
      reason: 'Agnes 2.5 Flash 画幅只支持 16:9 / 9:16 / 1:1',
    })
  })

  it('accepts extend and edit on Grok with a source video', () => {
    expect(
      validateVideoRequest(
        GROK,
        request({
          mode: 'extend',
          duration_seconds: 3,
          source_task_id: 't1',
          source_output_index: 0,
        }),
        0,
      ),
    ).toEqual({ ok: true })
    expect(
      validateVideoRequest(
        GROK,
        request({
          mode: 'edit',
          duration_seconds: 6.4,
          source_task_id: 't1',
          source_output_index: 1,
        }),
        0,
      ),
    ).toEqual({ ok: true })
  })

  it('rejects extend and edit on a model without that support', () => {
    expect(
      validateVideoRequest(
        AGNES,
        request({ mode: 'extend', source_task_id: 't1', source_output_index: 0 }),
        0,
      ),
    ).toEqual({ ok: false, reason: 'Agnes 2.5 Flash 不支持续写' })
    expect(
      validateVideoRequest(
        AGNES,
        request({ mode: 'edit', source_task_id: 't1', source_output_index: 0 }),
        0,
      ),
    ).toEqual({ ok: false, reason: 'Agnes 2.5 Flash 不支持改视频' })
  })

  it('rejects a source video that is missing or badly addressed', () => {
    expect(validateVideoRequest(GROK, request({ mode: 'extend' }), 0)).toEqual({
      ok: false,
      reason: '续写缺少源视频',
    })
    expect(
      validateVideoRequest(
        GROK,
        request({ mode: 'edit', source_task_id: 't1', source_output_index: -1 }),
        0,
      ),
    ).toEqual({ ok: false, reason: '改视频缺少源视频' })
  })

  it('rejects an extension length outside 2-10 seconds', () => {
    for (const seconds of [1, 11, 2.5]) {
      expect(
        validateVideoRequest(
          GROK,
          request({
            mode: 'extend',
            duration_seconds: seconds,
            source_task_id: 't1',
            source_output_index: 0,
          }),
          0,
        ),
      ).toEqual({ ok: false, reason: '续写时长只支持 2-10 秒' })
    }
  })

  it('rejects a keyframe combined with a source video', () => {
    expect(
      validateVideoRequest(
        GROK,
        request({
          mode: 'extend',
          first_frame_index: 0,
          source_task_id: 't1',
          source_output_index: 0,
        }),
        1,
      ),
    ).toEqual({ ok: false, reason: '续写和改视频不接受首尾帧' })
  })

  it('rejects a mode outside the vocabulary', () => {
    expect(validateVideoRequest(GROK, request({ mode: 'remix' as never }), 0)).toEqual({
      ok: false,
      reason: '不支持的视频模式',
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
    expect(VIDEO_MODEL_SUPPORT[AGNES].typicalSeconds).toBe(40)
  })

  it('offers extend and edit on Grok only', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK]).toMatchObject({ extend: true, edit: true })
    expect(VIDEO_MODEL_SUPPORT[AGNES]).toMatchObject({ extend: false, edit: false })
  })

  it('gives every model a distinct card tagline', () => {
    const taglines = Object.values(VIDEO_MODEL_SUPPORT).map((support) => support.tagline)
    expect(new Set(taglines).size).toBe(taglines.length)
  })
})
