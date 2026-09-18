import { describe, expect, it } from 'vitest'
import { floatGenerateBar } from '../../../../features/canvas/lib/generateBarPlacement'

const EMPTY = { loaded: true, messageCount: 0, historyLoading: false, historyFailed: false }

describe('画布底部的生成栏', () => {
  it('智能体的对话为空时浮在画布底部', () => {
    expect(floatGenerateBar(true, EMPTY)).toBe(true)
  })

  it('没有智能体时不浮出（用侧栏里的生成栏）', () => {
    expect(floatGenerateBar(false, EMPTY)).toBe(false)
  })

  it('有消息、正在加载、读失败或还没开始读时收起', () => {
    expect(floatGenerateBar(true, { ...EMPTY, messageCount: 1 })).toBe(false)
    expect(floatGenerateBar(true, { ...EMPTY, historyLoading: true })).toBe(false)
    expect(floatGenerateBar(true, { ...EMPTY, historyFailed: true })).toBe(false)
    expect(floatGenerateBar(true, { ...EMPTY, loaded: false })).toBe(false)
  })
})
