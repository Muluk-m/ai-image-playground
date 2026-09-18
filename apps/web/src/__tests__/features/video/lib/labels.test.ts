import { describe, expect, it } from 'vitest'
import { videoDeriveLabel } from '../../../../features/video/lib/labels'

describe('视频派生模式的译文', () => {
  it('两种模式都有译文', () => {
    expect(videoDeriveLabel('extend')).toBe('续写')
    expect(videoDeriveLabel('edit')).toBe('改视频')
  })
})
