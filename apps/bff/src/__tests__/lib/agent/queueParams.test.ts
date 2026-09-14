import { describe, expect, it } from 'bun:test'
import { queueParamsFor } from '../../../lib/agent/tools/queueParams'

describe('轮参数映射进队列请求', () => {
  it('没给参数时只保留默认的一张', () => {
    expect(queueParamsFor('openai-compat', undefined)).toEqual({ n: 1 })
  })

  it('size 为 auto 视同没选，不往上游发', () => {
    expect(queueParamsFor('openai-compat', { size: 'auto' })).toEqual({ n: 1 })
  })

  it('quality 为 auto 同样视同没选', () => {
    expect(queueParamsFor('openai-compat', { quality: 'auto' })).toEqual({ n: 1 })
  })

  it('openai 系带格式与审核级别', () => {
    expect(
      queueParamsFor('openai-compat', {
        size: '1024x1536',
        quality: 'high',
        output_format: 'webp',
        output_compression: 80,
        moderation: 'low',
      }),
    ).toEqual({
      n: 1,
      size: '1024x1536',
      quality: 'high',
      output_format: 'webp',
      output_compression: 80,
      moderation: 'low',
    })
  })

  it('png 不带压缩率：这个字段对 png 无意义', () => {
    const mapped = queueParamsFor('openai-compat', { output_format: 'png', output_compression: 80 })
    expect(mapped.output_compression).toBeUndefined()
  })

  // 1024x1536 实际是 2:3，但 Gemini 的档位表里没有 2:3，最接近的是 3:4。
  // size 同时照样带上：queueClient 就是这么发的，gemini 两个字段都收。
  it('gemini 系把 size 归到最接近的比例档，size 本身照样带上', () => {
    expect(queueParamsFor('gemini', { size: '1024x1536' })).toEqual({
      n: 1,
      size: '1024x1536',
      aspect_ratio: '3:4',
    })
  })

  it('gemini 系显式选了比例就以它为准，不再从 size 猜', () => {
    expect(
      queueParamsFor('gemini', { size: '1024x1536', gemini_aspect_ratio: '16:9' }),
    ).toMatchObject({ aspect_ratio: '16:9' })
  })

  it('gemini 系不带 openai 才认的格式与审核级别', () => {
    const mapped = queueParamsFor('gemini', { output_format: 'webp', moderation: 'low' })
    expect(mapped.output_format).toBeUndefined()
    expect(mapped.moderation).toBeUndefined()
  })

  it('gemini 的分辨率与思考级别原样带上', () => {
    expect(
      queueParamsFor('gemini', { gemini_image_size: '2K', gemini_thinking_level: 'low' }),
    ).toMatchObject({ image_size: '2K', thinking_level: 'low' })
  })

  it('数量按用户选的填，上限之外的截回上限', () => {
    expect(queueParamsFor('openai-compat', { n: 4 }).n).toBe(4)
    expect(queueParamsFor('openai-compat', { n: 999 }).n).toBe(10)
    expect(queueParamsFor('openai-compat', { n: 0 }).n).toBe(1)
  })

  it('模型不进请求体：它决定打哪个上游，不是请求字段', () => {
    expect(queueParamsFor('openai-compat', { model: 'gpt-image-2' })).toEqual({ n: 1 })
  })
})
