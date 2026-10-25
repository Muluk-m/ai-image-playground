import { describe, expect, it } from 'vitest'
import { describeError, UserFacingError } from '../../i18n'

describe('describeError', () => {
  it('shows our own user-facing messages and stored text as is', () => {
    expect(describeError(new UserFacingError('图片文件过大'))).toBe('图片文件过大')
    expect(describeError('已经算好的那句话')).toBe('已经算好的那句话')
  })

  it('turns browser storage and network failures into plain language', () => {
    expect(describeError(new DOMException('quota', 'QuotaExceededError'))).toBe(
      '浏览器存储空间不足，请清理后重试',
    )
    expect(describeError(new TypeError('Failed to fetch'))).toBe('网络连接失败，请检查网络后重试')
  })

  it('never shows raw messages of unexpected errors', () => {
    expect(describeError(new Error("Failed to execute 'drawImage'"))).toBe('操作没有完成，请重试')
    expect(describeError({ code: 42 })).toBe('操作没有完成，请重试')
  })
})
