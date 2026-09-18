import { describe, expect, it } from 'vitest'
import { generateBarPlacement } from '../../../../features/canvas/lib/generateBarPlacement'

describe('画布生成栏的位置', () => {
  it('没有智能体时一直在侧栏', () => {
    expect(generateBarPlacement(false, { messageCount: 3, historyLoading: true })).toBe('sidebar')
  })

  it('智能体的对话为空时浮在画布底部', () => {
    expect(generateBarPlacement(true, { messageCount: 0, historyLoading: false })).toBe('floating')
  })

  it('有消息或正在加载历史时收起', () => {
    expect(generateBarPlacement(true, { messageCount: 1, historyLoading: false })).toBe('hidden')
    expect(generateBarPlacement(true, { messageCount: 0, historyLoading: true })).toBe('hidden')
  })
})
