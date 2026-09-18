import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  clampVideoPreset,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTIONS,
  type VideoModelSupport,
  type VideoRequest,
  validateVideoPrompt,
  validateVideoRequest,
  videoDurationsForResolution,
  videoPresetConflicts,
  videoRateMultiplier,
  videoRequestRejection,
} from '../video-presets'

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5-flash'
const SEEDANCE = 'doubao-seedance-2-0-mini-260615'
const VEO_FAST = 'veo-3.1-fast-generate-preview'
const VEO_LITE = 'veo-3.1-lite-generate-preview'

function request(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p', ...overrides }
}

const CONSTRAINED = 'constrained-video-test-model'
const CONSTRAINED_SUPPORT: VideoModelSupport = {
  label: '受限模型',
  durations: [4, 6, 8],
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  resolutionMultipliers: { '720p': 1, '1080p': 1.2 },
  durationsByResolution: { '1080p': [8] },
  firstFrame: true,
  lastFrame: false,
  extend: false,
  edit: false,
  typicalSeconds: 60,
  tagline: '受限',
}

describe('validateVideoRequest', () => {
  // 组合约束要到 Veo 才有真模型，先用一条只在本 describe 里登记的矩阵条目测规则。
  beforeAll(() => {
    VIDEO_MODEL_SUPPORT[CONSTRAINED] = CONSTRAINED_SUPPORT
  })
  afterAll(() => {
    delete VIDEO_MODEL_SUPPORT[CONSTRAINED]
  })

  it('accepts the durations a constrained resolution allows', () => {
    expect(
      validateVideoRequest(CONSTRAINED, request({ duration_seconds: 8, resolution: '1080p' }), 0),
    ).toEqual({ ok: true })
    expect(
      validateVideoRequest(CONSTRAINED, request({ duration_seconds: 4, resolution: '720p' }), 0),
    ).toEqual({ ok: true })
  })

  it('rejects a duration the chosen resolution does not allow', () => {
    expect(
      validateVideoRequest(CONSTRAINED, request({ duration_seconds: 6, resolution: '1080p' }), 0),
    ).toEqual({ ok: false, reason: '受限模型 1080p 只支持 8 秒' })
  })

  it('accepts 4 and 6 second 720p Veo clips', () => {
    for (const model of [VEO_FAST, VEO_LITE]) {
      expect(validateVideoRequest(model, request({ duration_seconds: 4 }), 0)).toEqual({ ok: true })
      expect(validateVideoRequest(model, request({ duration_seconds: 6 }), 0)).toEqual({ ok: true })
    }
  })

  it('accepts 1080p Veo only at 8 seconds', () => {
    expect(
      validateVideoRequest(VEO_FAST, request({ duration_seconds: 8, resolution: '1080p' }), 0),
    ).toEqual({ ok: true })
    expect(
      validateVideoRequest(VEO_FAST, request({ duration_seconds: 6, resolution: '1080p' }), 0),
    ).toEqual({ ok: false, reason: 'Veo 3.1 Fast 1080p 只支持 8 秒' })
  })

  it('rejects 1:1, a last frame and deriving on Veo', () => {
    expect(
      validateVideoRequest(VEO_LITE, request({ duration_seconds: 4, aspect_ratio: '1:1' }), 0),
    ).toEqual({
      ok: false,
      reason: 'Veo 3.1 Lite 画幅只支持 16:9 / 9:16',
    })
    expect(
      validateVideoRequest(VEO_LITE, request({ duration_seconds: 4, last_frame_index: 0 }), 1),
    ).toEqual({ ok: false, reason: 'Veo 3.1 Lite 不支持尾帧' })
    expect(
      validateVideoRequest(
        VEO_LITE,
        request({
          duration_seconds: 4,
          mode: 'extend',
          source_task_id: 'src',
          source_output_index: 0,
        }),
        0,
      ),
    ).toEqual({ ok: false, reason: 'Veo 3.1 Lite 不支持续写' })
  })

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

  it('accepts a 15 second 1080p Seedance clip with both keyframes', () => {
    expect(
      validateVideoRequest(
        SEEDANCE,
        request({
          duration_seconds: 15,
          resolution: '1080p',
          first_frame_index: 0,
          last_frame_index: 1,
        }),
        2,
      ),
    ).toEqual({ ok: true })
  })

  it('rejects extend and edit on Seedance', () => {
    expect(
      validateVideoRequest(
        SEEDANCE,
        request({ mode: 'extend', source_task_id: 't1', source_output_index: 0 }),
        0,
      ),
    ).toEqual({ ok: false, reason: 'Seedance 2.0 不支持续写' })
  })

  it('accepts the 15 seconds a whole storyboard runs to on Grok', () => {
    expect(validateVideoRequest(GROK, request({ duration_seconds: 15 }), 0)).toEqual({ ok: true })
  })

  it('rejects 15 seconds on Agnes, whose ladder stops at 10', () => {
    expect(validateVideoRequest(AGNES, request({ duration_seconds: 15 }), 0)).toEqual({
      ok: false,
      reason: 'Agnes 2.5 Flash 时长只支持 5 / 8 / 10 秒',
    })
  })

  it('rejects an unsupported duration', () => {
    expect(validateVideoRequest(GROK, request({ duration_seconds: 12 }), 0)).toEqual({
      ok: false,
      reason: 'Grok 时长只支持 5 / 8 / 10 / 15 秒',
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
    ).toEqual({ ok: false, reason: '续写和改视频不接受首尾帧或参考图' })
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
  it('keeps the rate every existing model shipped with', () => {
    expect(videoRateMultiplier(GROK, '720p')).toBe(1)
    expect(videoRateMultiplier(GROK, '1080p')).toBe(1.6)
    expect(videoRateMultiplier(AGNES, '720p')).toBe(1)
    expect(videoRateMultiplier(SEEDANCE, '720p')).toBe(1)
    expect(videoRateMultiplier(SEEDANCE, '1080p')).toBe(1.6)
  })

  it('prices Veo 1080p at a fifth above 720p', () => {
    for (const model of [VEO_FAST, VEO_LITE]) {
      expect(videoRateMultiplier(model, '720p')).toBe(1)
      expect(videoRateMultiplier(model, '1080p')).toBe(1.2)
    }
  })

  it('falls back to one for a model or resolution outside the matrix', () => {
    expect(videoRateMultiplier(GROK, '2k')).toBe(1)
    expect(videoRateMultiplier('gpt-image-2', '720p')).toBe(1)
  })
})

describe('videoDurationsForResolution', () => {
  it('offers every duration of the model when the resolution is unconstrained', () => {
    for (const support of Object.values(VIDEO_MODEL_SUPPORT))
      for (const resolution of support.resolutions) {
        if (support.durationsByResolution?.[resolution]) continue
        expect(videoDurationsForResolution(support, resolution)).toEqual(support.durations)
      }
  })

  it('narrows Veo 1080p to the single length it renders', () => {
    expect(videoDurationsForResolution(VIDEO_MODEL_SUPPORT[VEO_FAST], '1080p')).toEqual([8])
    expect(videoDurationsForResolution(VIDEO_MODEL_SUPPORT[VEO_LITE], '720p')).toEqual([4, 6, 8])
  })

  it('narrows to the subset the model declares for that resolution', () => {
    expect(videoDurationsForResolution(CONSTRAINED_SUPPORT, '1080p')).toEqual([8])
    expect(videoDurationsForResolution(CONSTRAINED_SUPPORT, '720p')).toEqual([4, 6, 8])
  })
})

describe('VIDEO_MODEL_SUPPORT', () => {
  it('carries the typical elapsed seconds shown while generating', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK].typicalSeconds).toBe(40)
    expect(VIDEO_MODEL_SUPPORT[AGNES].typicalSeconds).toBe(40)
    expect(VIDEO_MODEL_SUPPORT[SEEDANCE].typicalSeconds).toBe(120)
  })

  it('offers extend and edit on Grok only', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK]).toMatchObject({ extend: true, edit: true })
    expect(VIDEO_MODEL_SUPPORT[AGNES]).toMatchObject({ extend: false, edit: false })
  })

  it('prices every resolution it offers and none it does not', () => {
    for (const support of Object.values(VIDEO_MODEL_SUPPORT))
      expect(Object.keys(support.resolutionMultipliers).sort()).toEqual(
        [...support.resolutions].sort(),
      )
  })

  it('constrains durations only for a resolution it offers, and only to durations it offers', () => {
    for (const support of [...Object.values(VIDEO_MODEL_SUPPORT), CONSTRAINED_SUPPORT])
      for (const resolution of VIDEO_RESOLUTIONS) {
        const durations = support.durationsByResolution?.[resolution]
        if (!durations) continue
        expect(support.resolutions).toContain(resolution)
        expect(durations.length).toBeGreaterThan(0)
        for (const duration of durations) expect(support.durations).toContain(duration)
      }
  })

  it('gives every model a distinct card tagline', () => {
    const taglines = Object.values(VIDEO_MODEL_SUPPORT).map((support) => support.tagline)
    expect(new Set(taglines).size).toBe(taglines.length)
  })
})

describe('validateVideoPrompt', () => {
  it('accepts a prompt at the cap the model declares', () => {
    const cap = VIDEO_MODEL_SUPPORT[VEO_FAST].promptMaxChars!
    expect(validateVideoPrompt(VEO_FAST, '光'.repeat(cap))).toEqual({ ok: true })
  })

  it('rejects a prompt past the cap and names it', () => {
    const cap = VIDEO_MODEL_SUPPORT[VEO_LITE].promptMaxChars!
    expect(validateVideoPrompt(VEO_LITE, '光'.repeat(cap + 1))).toEqual({
      ok: false,
      reason: `Veo 3.1 Lite 描述最多 ${cap} 字`,
    })
  })

  it('leaves models without a cap unlimited', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK].promptMaxChars).toBeUndefined()
    expect(validateVideoPrompt(GROK, '光'.repeat(9000))).toEqual({ ok: true })
    expect(validateVideoPrompt('gpt-image-2', '光'.repeat(9000))).toEqual({ ok: true })
  })
})

describe('videoPresetConflicts', () => {
  const veo = VIDEO_MODEL_SUPPORT[VEO_FAST]
  const grok = VIDEO_MODEL_SUPPORT[GROK]
  const agnes = VIDEO_MODEL_SUPPORT[AGNES]

  it('stays silent about what the caller never asked for', () => {
    // 没填的项按默认退档，那不是丢掉用户的约束，不该报冲突。
    expect(videoPresetConflicts(veo, {})).toEqual([])
    expect(videoPresetConflicts(agnes, {})).toEqual([])
  })

  it('stays silent when every asked value lands as asked', () => {
    expect(
      videoPresetConflicts(grok, { duration: 10, resolution: '1080p', aspectRatio: '9:16' }),
    ).toEqual([])
  })

  it('names the duration this model cannot do, and what it can', () => {
    expect(videoPresetConflicts(grok, { duration: 6 })).toEqual([
      { field: 'duration', asked: 6, used: 5, supported: [5, 8, 10, 15], resolution: '720p' },
    ])
  })

  it('reports the duration against the resolution that would actually be used', () => {
    // Veo 的 1080p 只配 8 秒；报 4 / 6 / 8 等于把用户导向另一个做不到的值。
    expect(videoPresetConflicts(veo, { duration: 6, resolution: '1080p' })).toEqual([
      { field: 'duration', asked: 6, used: 8, supported: [8], resolution: '1080p' },
    ])
  })

  it('names an unsupported resolution', () => {
    expect(videoPresetConflicts(agnes, { resolution: '1080p' })).toEqual([
      { field: 'resolution', asked: '1080p', used: '720p', supported: ['720p'] },
    ])
  })

  it('names an unsupported aspect ratio', () => {
    expect(videoPresetConflicts(veo, { aspectRatio: '1:1' })).toEqual([
      { field: 'aspectRatio', asked: '1:1', used: '16:9', supported: ['16:9', '9:16'] },
    ])
  })

  it('reports every asked value that misses, not just the first', () => {
    expect(
      videoPresetConflicts(veo, { duration: 15, resolution: '2k', aspectRatio: '1:1' }).map(
        (conflict) => conflict.field,
      ),
    ).toEqual(['duration', 'resolution', 'aspectRatio'])
  })

  it('agrees with clampVideoPreset on what would be submitted', () => {
    const asked = { duration: 15, aspectRatio: '1:1', resolution: '2k' } as const
    const preset = clampVideoPreset(veo, asked)
    for (const conflict of videoPresetConflicts(veo, asked)) {
      expect(conflict.used).toBe(
        conflict.field === 'duration'
          ? preset.duration
          : conflict.field === 'resolution'
            ? preset.resolution
            : preset.aspectRatio,
      )
    }
  })
})

describe('reference images', () => {
  const refs = (count: number, from = 0) => Array.from({ length: count }, (_, i) => i + from)

  it('declares Grok up to 7 at 720p with frames, Seedance up to 9 at 720p without frames', () => {
    expect(VIDEO_MODEL_SUPPORT[GROK].referenceImages).toEqual({
      max: 7,
      maxResolution: '720p',
      withFrames: true,
    })
    // 方舟文档：图片参考 0~9 张；Mini 只出 480p / 720p；首尾帧是另一种模式，全模态参考里只能用提示词间接指定。
    expect(VIDEO_MODEL_SUPPORT[SEEDANCE].referenceImages).toEqual({
      max: 9,
      maxResolution: '720p',
      withFrames: false,
    })
    for (const model of [AGNES, VEO_FAST, VEO_LITE])
      expect(VIDEO_MODEL_SUPPORT[model].referenceImages).toBeUndefined()
  })

  it('accepts reference images alone or next to a first frame on Grok', () => {
    expect(videoRequestRejection(GROK, request({ reference_image_indices: refs(7) }), 7)).toBeNull()
    expect(
      videoRequestRejection(
        GROK,
        request({ first_frame_index: 0, reference_image_indices: refs(3, 1) }),
        4,
      ),
    ).toBeNull()
  })

  it('rejects frames next to references on Seedance', () => {
    expect(
      videoRequestRejection(
        SEEDANCE,
        request({ first_frame_index: 0, reference_image_indices: [1] }),
        2,
      )?.code,
    ).toBe('referenceFramesRejected')
    expect(
      videoRequestRejection(SEEDANCE, request({ reference_image_indices: [0, 1] }), 2),
    ).toBeNull()
  })

  it('rejects reference images on a model that does not take them', () => {
    expect(videoRequestRejection(AGNES, request({ reference_image_indices: [0] }), 1)?.code).toBe(
      'referenceUnsupported',
    )
  })

  it('rejects more reference images than the model takes', () => {
    const found = videoRequestRejection(GROK, request({ reference_image_indices: refs(8) }), 8)
    expect(found).toMatchObject({ code: 'referenceTooMany', params: { label: 'Grok', max: 7 } })
  })

  it('rejects a resolution above the reference cap', () => {
    const found = videoRequestRejection(
      GROK,
      request({ resolution: '1080p', reference_image_indices: [0] }),
      1,
    )
    expect(found).toMatchObject({
      code: 'referenceResolutionUnsupported',
      params: { label: 'Grok', resolution: '720p' },
    })
  })

  it('rejects frames next to references when the model cannot combine them', () => {
    VIDEO_MODEL_SUPPORT[CONSTRAINED] = {
      ...CONSTRAINED_SUPPORT,
      referenceImages: { max: 3, maxResolution: '1080p', withFrames: false },
    }
    try {
      expect(
        videoRequestRejection(
          CONSTRAINED,
          request({ duration_seconds: 4, first_frame_index: 0, reference_image_indices: [1] }),
          2,
        )?.code,
      ).toBe('referenceFramesRejected')
    } finally {
      delete VIDEO_MODEL_SUPPORT[CONSTRAINED]
    }
  })

  it('rejects reference indices that miss, repeat or overlap a frame', () => {
    for (const video of [
      request({ reference_image_indices: [2] }),
      request({ reference_image_indices: [0, 0] }),
      request({ reference_image_indices: [1.5] }),
      request({ first_frame_index: 0, reference_image_indices: [0] }),
    ])
      expect(videoRequestRejection(GROK, video, 2)?.code).toBe('referenceImageMissing')
  })

  it('treats an empty reference list as none', () => {
    expect(videoRequestRejection(AGNES, request({ reference_image_indices: [] }), 0)).toBeNull()
  })

  it('refuses reference images on extend and edit', () => {
    expect(
      videoRequestRejection(
        GROK,
        request({
          mode: 'extend',
          source_task_id: 'task',
          source_output_index: 0,
          reference_image_indices: [0],
        }),
        1,
      )?.code,
    ).toBe('deriveFramesRejected')
  })
})
