import { describe, expect, it } from 'vitest'
import { computePromptHeight, PROMPT_COLLAPSED_MAX_H, PROMPT_MIN_H } from '../../lib/promptHeight'

// 标准桌面视口 + 不含图片 thumbs 的卡片 overhead（≈ 140px）。
const STD = { innerHeight: 1080, fixedOverhead: 140 }

describe('computePromptHeight', () => {
  it('短文本（小于 minH）：targetH 等于 minH，不显示折叠按钮', () => {
    const r = computePromptHeight({ ...STD, scrollH: 10, promptCollapsed: false })
    expect(r.targetH).toBe(PROMPT_MIN_H)
    expect(r.overflow).toBe(false)
    expect(r.scroll).toBe(false)
  })

  it('1 行文本（约 42px）：取实际高度，不折叠不滚动', () => {
    const r = computePromptHeight({ ...STD, scrollH: 42, promptCollapsed: false })
    expect(r.targetH).toBe(42)
    expect(r.overflow).toBe(false)
    expect(r.scroll).toBe(false)
  })

  it('刚好 3 行（=84px）：边界判定，仍不算 overflow', () => {
    const r = computePromptHeight({ ...STD, scrollH: 84, promptCollapsed: false })
    expect(r.targetH).toBe(84)
    expect(r.overflow).toBe(false)
  })

  it('刚超过 3 行（85px）：开始显示折叠按钮', () => {
    const r = computePromptHeight({ ...STD, scrollH: 85, promptCollapsed: false })
    expect(r.overflow).toBe(true)
  })

  it('长文本 + 展开态：撑到 40% 视口减 overhead 的上限', () => {
    const r = computePromptHeight({ ...STD, scrollH: 600, promptCollapsed: false })
    // 1080 * 0.4 - 140 = 292
    expect(r.targetH).toBe(292)
    expect(r.overflow).toBe(true)
    expect(r.scroll).toBe(true) // 内容超过 maxH 应该开滚动
  })

  it('长文本 + 折叠态：targetH 被压到 PROMPT_COLLAPSED_MAX_H', () => {
    const r = computePromptHeight({ ...STD, scrollH: 600, promptCollapsed: true })
    expect(r.targetH).toBe(PROMPT_COLLAPSED_MAX_H)
    expect(r.overflow).toBe(true)
    expect(r.scroll).toBe(true)
  })

  it('折叠态 + 中等长度（介于 84 和展开 maxH 之间）：仍压到 84', () => {
    const r = computePromptHeight({ ...STD, scrollH: 200, promptCollapsed: true })
    expect(r.targetH).toBe(PROMPT_COLLAPSED_MAX_H)
    expect(r.overflow).toBe(true)
    expect(r.scroll).toBe(true)
  })

  it('折叠态 + 短文本（< 84）：不压缩，按内容高度走', () => {
    const r = computePromptHeight({ ...STD, scrollH: 60, promptCollapsed: true })
    expect(r.targetH).toBe(60)
    expect(r.overflow).toBe(false)
    expect(r.scroll).toBe(false)
  })

  it('极小屏 / overhead 极大：触底保护 80px 下限', () => {
    // 400 * 0.4 - 300 = -140，下限被夹到 80
    const r = computePromptHeight({
      innerHeight: 400,
      fixedOverhead: 300,
      scrollH: 600,
      promptCollapsed: false,
    })
    expect(r.targetH).toBe(80)
    expect(r.overflow).toBe(true)
    expect(r.scroll).toBe(true)
  })

  it('极小屏 + 折叠态：可用空间已小于 84，不会更小', () => {
    // expandedMaxH = 80（下限），folded 时 min(80, 84) = 80
    const r = computePromptHeight({
      innerHeight: 400,
      fixedOverhead: 300,
      scrollH: 600,
      promptCollapsed: true,
    })
    expect(r.targetH).toBe(80)
  })

  it('大量图片 thumbs 抬高 overhead：可用空间相应压缩', () => {
    // 1080 * 0.4 - 340 = 92
    const r = computePromptHeight({
      innerHeight: 1080,
      fixedOverhead: 340,
      scrollH: 600,
      promptCollapsed: false,
    })
    expect(r.targetH).toBe(92)
    expect(r.scroll).toBe(true)
  })

  it('targetH 永远不会超过 expandedMaxH，也不会低于 PROMPT_MIN_H', () => {
    // 用 fuzz 式的几个组合体检不变式
    for (const scrollH of [0, 30, 60, 84, 85, 200, 600, 1200]) {
      for (const collapsed of [false, true]) {
        const r = computePromptHeight({ ...STD, scrollH, promptCollapsed: collapsed })
        expect(r.targetH).toBeGreaterThanOrEqual(PROMPT_MIN_H)
        expect(r.targetH).toBeLessThanOrEqual(1080 * 0.4 - 140)
      }
    }
  })
})
