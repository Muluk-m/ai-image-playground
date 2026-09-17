import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { videoDeriveLabel, videoTaglineLabel } from '../../../../features/video/lib/labels'

/**
 * `tagline` 的译文 key 靠 `labels.ts` 里一张手工别名表映射——model id 里有点号，
 * 是 i18next 的 keySeparator，不能直接拼进 key。手工表会漂：往 VIDEO_MODEL_SUPPORT
 * 加模型时忘了同步，`videoTaglineLabel` 返回空串，卡片会渲染成一个孤零零的圆点开头，
 * 而且不报错、不红任何测试。这个文件就是拦这条。
 */
describe('视频模型的 tagline 译文', () => {
  const modelIds = Object.keys(VIDEO_MODEL_SUPPORT)

  it('支持矩阵不是空的', () => {
    expect(modelIds.length).toBeGreaterThan(0)
  })

  it.each(modelIds.map((id) => [id]))('%s 配得上一条 tagline 译文', (modelId) => {
    expect(VIDEO_MODEL_SUPPORT[modelId]?.tagline).toBeTruthy()
    expect(videoTaglineLabel(modelId)).not.toBe('')
  })

  it('认不出的 model id 返回空串而不是抛错', () => {
    expect(videoTaglineLabel('not-a-real-model')).toBe('')
  })

  it('派生模式两种都有译文', () => {
    expect(videoDeriveLabel('extend')).toBe('续写')
    expect(videoDeriveLabel('edit')).toBe('改视频')
  })
})
