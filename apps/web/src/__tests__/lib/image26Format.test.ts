import { describe, expect, it } from 'vitest'
import { gifFrameSize, switchImageOutputFormat } from '../../lib/image26Format'
import { DEFAULT_PARAMS } from '../../types'

describe('switchImageOutputFormat', () => {
  it('先设置自定义尺寸 816，再切 GIF 选 768，提交的 size 是 768x768', () => {
    const custom = {
      ...DEFAULT_PARAMS,
      size: '816x816',
      quality: 'low' as const,
      n: 3,
    }
    const switched = switchImageOutputFormat(custom, 'gif', null)
    expect(switched.patch).toMatchObject({
      output_format: 'gif',
      quality: 'medium',
      size: '768x768',
      n: 1,
    })
    const picked = { ...custom, ...switched.patch, size: '768x768' as const }
    expect(gifFrameSize(picked.size)).toBe('768x768')

    const back = switchImageOutputFormat(picked, 'png', switched.still)
    expect(back.patch.size).toBe('816x816')
    expect(back.patch.quality).toBe('low')
    expect(back.patch.n).toBe(3)
    expect(back.patch.output_format).toBe('png')
  })

  it('keeps a chosen 512 frame size and does not let a later still size replace it', () => {
    const gif = switchImageOutputFormat(
      { ...DEFAULT_PARAMS, size: '1024x1024', output_format: 'png' },
      'gif',
      null,
    )
    const at512 = {
      ...DEFAULT_PARAMS,
      ...gif.patch,
      size: '512x512' as const,
      output_format: 'gif' as const,
    }
    expect(gifFrameSize(at512.size)).toBe('512x512')
    expect(gifFrameSize('816x816')).toBe('768x768')
  })
})

describe('switchImageOutputFormat 在静态格式之间切换', () => {
  it('已经是静态图时，再点「图片」不会拿旧快照覆盖当前设置', () => {
    const stale = {
      size: '816x816',
      quality: 'low' as const,
      n: 3,
      output_compression: null,
      transparent_output: false,
    }
    const current = { ...DEFAULT_PARAMS, output_format: 'png' as const, size: '1024x1024', n: 1 }
    const result = switchImageOutputFormat(current, 'png', stale)
    expect(result.patch).not.toHaveProperty('size')
    expect(result.patch).not.toHaveProperty('n')
    expect(result.still).toBeNull()
  })
})
