import { describe, expect, it } from 'bun:test'
import { imageSizeTier, sizeForAspectRatio } from '@image-playground/shared'
import {
  queueParamsFor,
  requestedImageCount,
  withAspectRatio,
} from '../../../lib/agent/tools/queueParams'

describe('轮参数映射进队列请求', () => {
  it('size 为 auto 视同没选，不往上游发', () => {
    expect(queueParamsFor('openai-compat', { size: 'auto' })).not.toHaveProperty('size')
  })

  it('quality 为 auto 同样视同没选', () => {
    expect(queueParamsFor('openai-compat', { quality: 'auto' })).not.toHaveProperty('quality')
  })

  // 审核强度由 createQueueTask 兜底（taskSubmission.ts），映射这一层不该重复一遍。
  it('审核强度不在映射里补，交给建任务那一处兜底', () => {
    expect(queueParamsFor('openai-compat', undefined)).not.toHaveProperty('moderation')
    expect(queueParamsFor('gemini', { size: '1024x1536' })).not.toHaveProperty('moderation')
  })

  it('png 不带压缩率：这个字段对 png 无意义', () => {
    const mapped = queueParamsFor('openai-compat', { output_format: 'png', output_compression: 80 })
    expect(mapped.output_compression).toBeUndefined()
  })

  // 1024x1536 实际是 2:3，但 Gemini 的档位表里没有 2:3，最接近的是 3:4。
  // size 同时照样带上：queueClient 就是这么发的，gemini 两个字段都收。
  it('gemini 系把 size 归到最接近的比例档，size 本身照样带上', () => {
    expect(queueParamsFor('gemini', { size: '1024x1536' })).toEqual({
      size: '1024x1536',
      aspect_ratio: '3:4',
    })
  })

  it('gemini 系显式选了比例就以它为准，不再从 size 猜', () => {
    expect(
      queueParamsFor('gemini', { size: '1024x1536', gemini_aspect_ratio: '16:9' }),
    ).toMatchObject({ aspect_ratio: '16:9' })
  })

  it('工具没写张数时沿用用户本轮选择的张数', () => {
    expect(requestedImageCount(undefined, 4)).toBe(4)
    expect(requestedImageCount(2, 4)).toBe(2)
    expect(requestedImageCount(undefined, undefined)).toBe(1)
    expect(requestedImageCount(99, 4)).toBe(10)
  })

  it('gemini 系不带 openai 才认的输出格式', () => {
    const mapped = queueParamsFor('gemini', { output_format: 'webp' })
    expect(mapped.output_format).toBeUndefined()
  })
})

describe('模型按用户原话指定比例', () => {
  it('保持用户的清晰度档位，换成指定比例的尺寸', () => {
    expect(withAspectRatio({ size: '1024x1024', quality: 'high' }, '16:9')).toEqual({
      size: '1280x720',
      quality: 'high',
    })
    expect(withAspectRatio({ size: '2048x2048' }, '9:16')?.size).toBe('1440x2560')
    expect(withAspectRatio({ size: '3840x2160' }, '1:1')?.size).toBe('2880x2880')
  })

  it('输入框是 auto 或没有参数时按 1K 档换算', () => {
    expect(withAspectRatio({ size: 'auto' }, '16:9')?.size).toBe('1280x720')
    expect(withAspectRatio(undefined, '3:4')?.size).toBe('768x1024')
  })

  it('没指定比例时原样沿用轮参数', () => {
    const params = { size: '1024x1536' }
    expect(withAspectRatio(params, undefined)).toBe(params)
  })

  it('换算后的尺寸送进队列请求；gemini 归到最接近的 aspectRatio', () => {
    expect(
      queueParamsFor('openai-compat', withAspectRatio({ size: '1024x1024' }, '16:9')),
    ).toMatchObject({
      size: '1280x720',
    })
    expect(
      queueParamsFor(
        'gemini',
        withAspectRatio({ size: '1024x1024', gemini_aspect_ratio: '1:1' }, '9:16'),
      ),
    ).toMatchObject({ aspect_ratio: '9:16' })
    expect(imageSizeTier('1536x1024')).toBe('1K')
    expect(imageSizeTier('2560x1440')).toBe('2K')
    expect(sizeForAspectRatio('2560x1440', '4:3')).toBe('2048x1536')
  })
})
