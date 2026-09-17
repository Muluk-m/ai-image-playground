import { describe, expect, it } from 'vitest'

import { trendTick } from '../../../components/ops/HostTrendChart'

const hour = 60 * 60 * 1000
// 本地时间构造，断言才不随跑测试的机器所在时区变。
const at = new Date(2026, 8, 17, 9, 5).getTime()

describe('trendTick', () => {
  it('一天之内的曲线标时刻：标日期的话每个刻度都一样', () => {
    expect(trendTick(at, 20 * hour)).toBe('09:05')
  })

  it('两三天的曲线日期和时刻都要，单标哪个都会重复', () => {
    expect(trendTick(at, 48 * hour)).toBe('09-17 09:05')
  })

  it('攒满一周之后只标日期', () => {
    expect(trendTick(at, 7 * 24 * hour)).toBe('09-17')
  })
})
