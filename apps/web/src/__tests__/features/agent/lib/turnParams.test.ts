import { describe, expect, it } from 'vitest'
import { toAgentTurnParams } from '../../../../features/agent/lib/turnParams'
import { DEFAULT_PARAMS } from '../../../../types'

describe('工作台参数转成轮参数', () => {
  it('全是默认值时不往服务端送任何东西', () => {
    expect(toAgentTurnParams(DEFAULT_PARAMS, undefined)).toBeUndefined()
  })

  it('选了模型就带上模型', () => {
    expect(toAgentTurnParams(DEFAULT_PARAMS, 'gpt-image-2')).toEqual({ model: 'gpt-image-2' })
  })

  it('选过的项逐字带上', () => {
    expect(
      toAgentTurnParams(
        {
          ...DEFAULT_PARAMS,
          size: '1024x1536',
          quality: 'high',
          output_format: 'webp',
          output_compression: 80,
          moderation: 'low',
          n: 3,
        },
        undefined,
      ),
    ).toEqual({
      size: '1024x1536',
      quality: 'high',
      output_format: 'webp',
      output_compression: 80,
      moderation: 'low',
      n: 3,
    })
  })

  it('gemini 专属三项照带', () => {
    expect(
      toAgentTurnParams(
        {
          ...DEFAULT_PARAMS,
          gemini_aspect_ratio: '16:9',
          gemini_image_size: '2K',
          gemini_thinking_level: 'high',
        },
        undefined,
      ),
    ).toEqual({
      gemini_aspect_ratio: '16:9',
      gemini_image_size: '2K',
      gemini_thinking_level: 'high',
    })
  })

  it('n 为 1 视同没选：服务端本来就按 1 走', () => {
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 1 }, undefined)).toBeUndefined()
  })

  it('透明与防改写不带：智能体那条路做不到，带上去等于骗用户', () => {
    const mapped = toAgentTurnParams(
      { ...DEFAULT_PARAMS, transparent_output: true, no_rewrite: false, size: '1024x1024' },
      undefined,
    )
    expect(mapped).toEqual({ size: '1024x1024' })
    expect(JSON.stringify(mapped)).not.toContain('transparent')
    expect(JSON.stringify(mapped)).not.toContain('rewrite')
  })
})
