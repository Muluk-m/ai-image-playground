import { describe, expect, it } from 'vitest'
import { computePromptHeight, PROMPT_MIN_H } from '../../lib/promptHeight'

// 标准桌面视口 + 不含图片 thumbs 的卡片 overhead（≈ 140px）。
const STD = { innerHeight: 1080, fixedOverhead: 140 }

describe('computePromptHeight', () => {
  it('内容小于 PROMPT_MIN_H 时夹回 minH', () => {
    const r = computePromptHeight({ ...STD, scrollH: 10 })
    expect(r.targetH).toBe(PROMPT_MIN_H)
    expect(r.scroll).toBe(false)
  })

  it('单行（约 42px）：targetH = scrollH，不出滚动条', () => {
    const r = computePromptHeight({ ...STD, scrollH: 42 })
    expect(r.targetH).toBe(42)
    expect(r.scroll).toBe(false)
  })

  it('中等长度（远小于上限）：按内容高度自适应', () => {
    const r = computePromptHeight({ ...STD, scrollH: 120 })
    expect(r.targetH).toBe(120)
    expect(r.scroll).toBe(false)
  })

  it('刚好等于 expandedMaxH 上限：不滚动', () => {
    // 1080 * 0.4 - 140 = 292
    const r = computePromptHeight({ ...STD, scrollH: 292 })
    expect(r.targetH).toBe(292)
    expect(r.scroll).toBe(false)
  })

  it('超过 expandedMaxH：targetH 被夹到上限并开启滚动', () => {
    const r = computePromptHeight({ ...STD, scrollH: 600 })
    expect(r.targetH).toBe(292)
    expect(r.scroll).toBe(true)
  })

  it('极小屏 + overhead 极大：触底保护 80px 下限', () => {
    // 400 * 0.4 - 300 = -140，被夹到 80
    const r = computePromptHeight({
      innerHeight: 400,
      fixedOverhead: 300,
      scrollH: 600,
    })
    expect(r.targetH).toBe(80)
    expect(r.scroll).toBe(true)
  })

  it('极小屏 + 短文本：targetH 仍至少为 minH', () => {
    // expandedMaxH = 80（下限），desired = max(10, minH) = minH = 42 → min(42,80) = 42
    const r = computePromptHeight({
      innerHeight: 400,
      fixedOverhead: 300,
      scrollH: 10,
    })
    expect(r.targetH).toBe(PROMPT_MIN_H)
    expect(r.scroll).toBe(false)
  })

  it('大量图片 thumbs 抬高 overhead：可用空间被压缩', () => {
    // 1080 * 0.4 - 340 = 92
    const r = computePromptHeight({
      innerHeight: 1080,
      fixedOverhead: 340,
      scrollH: 600,
    })
    expect(r.targetH).toBe(92)
    expect(r.scroll).toBe(true)
  })

  it('不变式：targetH 始终在 [PROMPT_MIN_H, expandedMaxH] 之间', () => {
    for (const innerHeight of [400, 720, 1080, 1440]) {
      for (const fixedOverhead of [100, 200, 400]) {
        const expandedMaxH = Math.max(innerHeight * 0.4 - fixedOverhead, 80)
        for (const scrollH of [0, 30, 60, 84, 85, 200, 600, 1200]) {
          const r = computePromptHeight({ innerHeight, fixedOverhead, scrollH })
          expect(r.targetH).toBeGreaterThanOrEqual(Math.min(PROMPT_MIN_H, expandedMaxH))
          expect(r.targetH).toBeLessThanOrEqual(expandedMaxH)
        }
      }
    }
  })

  it('scroll 仅在内容超过 maxH 时为 true', () => {
    expect(computePromptHeight({ ...STD, scrollH: 200 }).scroll).toBe(false)
    expect(computePromptHeight({ ...STD, scrollH: 292 }).scroll).toBe(false)
    expect(computePromptHeight({ ...STD, scrollH: 293 }).scroll).toBe(true)
  })
})
