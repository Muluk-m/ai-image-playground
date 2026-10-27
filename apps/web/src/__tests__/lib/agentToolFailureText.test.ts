import { describe, expect, it } from 'vitest'
import '../../i18n'
import { agentToolFailureText } from '../../lib/taskError'

describe('agentToolFailureText', () => {
  // BUG-48：取网图拿到网页时，时间线不说「参数不成立」。
  it('says the address gave no usable image for image-fetch tools', () => {
    expect(agentToolFailureText('invalid_params', 'fetchImage')).toBe(
      '这个地址取回来的不是可用的图片，请换一个图片地址',
    )
  })

  it('keeps the generic copy for listing pages, where the address may simply not be a product page', () => {
    expect(agentToolFailureText('invalid_params', 'fetchListingImages')).not.toBe(
      '这个地址取回来的不是可用的图片，请换一个图片地址',
    )
  })

  it('keeps the generic copy for other tools', () => {
    expect(agentToolFailureText('invalid_params', 'editImage')).toBe('这次的参数不成立，没有提交')
    expect(agentToolFailureText('source_unavailable', 'fetchImage')).toBe(
      '来源网站拒绝或无法提供内容，请换个公开来源',
    )
  })
})
